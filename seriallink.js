const SerialPort = require('serialport');
const crc8 = require('./crc8');
const cbor = require('cbor');

class ITMPSerialLink {
  constructor(itmp, name, portname, props = { baudRate: 115200 }) {
    this.lnkname = name;
    this.addressable = true;
    this.port = new SerialPort(portname, props, (err) => {
      if (err) {
        return console.log('Open Error: ', err.message);
      }
    });

    this.itmp = itmp;

    this.polls = new Map();

    // incoming messages encoding
    this.inbuf = Buffer.allocUnsafe(1024); // buffer for incoming bytes
    this.inpos = 0; // number of received bytes (inbuf position)
    this.lastchar = 0; // code of last received char =0 means no special character
    this.incrc = 0xff; // current crc calculation

    this.ready = false; // port opened flag
    this.busy = false; // bus busy flag
    this.timerId = null; // timeout timer id

    this.cur_addr = 0; // current transaction address
    this.cur_buf = Buffer.allocUnsafe(1024);
    this.msgqueue = [];

    // Open errors will be emitted as an error event
    this.port.on('error', (err) => {
      console.log('Error: ', err.message);
    });
    this.port.on('data', (data) => {
      this.income(data);
    });
    this.port.on('open', () => {
      // open logic
      this.ready = true; // port opened flag
      console.log('open');
    });
    this.reopen = (that) => {
      if (!that.port.isOpen) {
        that.port.open(() => {
          setTimeout(that.reopen, 1000, that);
        });
      }
    };
    this.port.on('close', () => {
      // open logic
      this.ready = false; // port opened flag
      setTimeout(this.reopen, 1000, this);
      console.log('close');
    });
    this.ports = {};
    SerialPort.list((err, ports) => {
      const ctx = this;
      ports.forEach((port) => {
        ctx.ports[port.comName] = port;
        // console.log(port.comName+JSON.stringify(port));
        // console.log(port.manufacturer);
      });
    });
  }

  subscribe(subaddr, suburi, opts, done) {
    //    const that = this;
    const sub = setInterval(() => {
      const that2 = this;
      this.itmp.call(`${this.lnkname}/${subaddr}`, suburi, null, (data, ropts) => {
        const url = `${that2.lnkname}/${subaddr}/${suburi}`;
        // if ()
        that2.itmp.emitEvent(url, data, ropts);
      });
    }, 1000);
    this.polls.set(`${subaddr}/${suburi}`, sub);
    done();
  }

  unsubscribe(subaddr, suburi, opts, done, err) {
    const timer = this.polls.get(`${subaddr}/${suburi}`);
    if (timer) {
      clearInterval(timer);
      done();
    } else {
      err();
    }
  }

  call(subaddr, suburi) {
    if (suburi === '') {
      return this.ports;
    }
    return null;
  }

  income(data) {
    for (let i = 0; i < data.length; i++) {
      if (this.lastchar === 0x7d) {
        this.inbuf[this.inpos] = data[i] ^ 0x20;
        this.incrc = crc8.docrc8(this.incrc, this.inbuf[this.inpos]);
        this.inpos++;
        this.lastchar = 0;
      } else if (data[i] === 0x7d) {
        this.lastchar = 0x7d;
      } else if (data[i] === 0x7e) {
        if (this.inpos > 2 && this.incrc === 0 /* this.inbuf[this.inpos-1] */) {
          const addr = this.inbuf[0];

          if (typeof this.itmp.process === 'function') {
            const msg = cbor.decode(this.inbuf.slice(1, this.inpos - 1));
            this.itmp.process(`${this.lnkname}/${addr}`, msg);
          }

          this.lastchar = 0;
          this.inpos = 0;
          this.incrc = 0xff;
          this.nexttransaction();
        }
      } else {
        this.inbuf[this.inpos] = data[i];
        this.incrc = crc8.docrc8(this.incrc, this.inbuf[this.inpos]);
        this.inpos += 1;
      }
    }
  }

  nexttransaction() {
    if (this.msgqueue.length > 0) {
      const [addr, msg] = this.msgqueue.shift();
      this.cur_addr = addr;
      clearTimeout(this.timerId);
      this.timerId = setTimeout(() => {
        this.timeisout();
      }, 200);
      this.internalsend(addr, msg);
    } else {
      this.cur_addr = 0;
      if (this.busy) {
        this.busy = false;
        clearTimeout(this.timerId);
      } else {
        console.log('message written');
      }
    }
  }

  timeisout() {
    if (typeof this.cur_err === 'function') {
      this.cur_err('timeout');
    }
    this.nexttransaction();
  }

  send(addr, msg) {
    const binmsg = cbor.encode(msg);

    if (this.busy) {
      this.msgqueue.push([addr, binmsg]);
    } else {
      this.busy = true;
      this.cur_addr = addr;
      this.timerId = setTimeout(() => {
        this.timeisout();
      }, 1000);
      this.internalsend(addr, binmsg);
    }
  }

  internalsend(addr, binmsg) {
    if (this.cur_buf.length < binmsg.length * 2) {
      this.cur_buf = Buffer.allocUnsafe(binmsg.length * 2);
    }

    let crc = 0xff;
    this.cur_buf[0] = 0x7e;
    this.cur_buf[1] = addr; // address
    crc = crc8.docrc8(crc, this.cur_buf[1]);

    let pos = 2;
    for (let i = 0; i < binmsg.length; i++) {
      crc = crc8.docrc8(crc, binmsg[i]);
      if (binmsg[i] === 0x7e || binmsg[i] === 0x7d) {
        this.cur_buf[pos] = 0x7d;
        this.cur_buf[pos + 1] = binmsg[i] ^ 0x20;
        pos += 2;
      } else {
        this.cur_buf[pos] = binmsg[i];
        pos++;
      }
    }
    if (crc === 0x7e || crc === 0x7d) {
      this.cur_buf[pos] = 0x7d;
      this.cur_buf[pos + 1] = crc ^ 0x20;
      pos += 2;
    } else {
      this.cur_buf[pos] = crc;
      pos++;
    }

    this.cur_buf[pos] = 0x7e;
    const sndbuf = this.cur_buf.slice(0, pos + 1);

    this.port.write(sndbuf, (errdt) => {
      if (errdt) {
        console.log('Error on write: ', errdt.message);
      }

      // console.log('message written');
    });
    //    var timerId = setTimeout( (key)=>{ var prom = that.transactions.get(key); 
    // that.transactions.delete(key); prom.err("timeout"); }, 2000, key);
  }
  queueSize() {
    return this.msgqueue.length;
  }
}

module.exports = ITMPSerialLink;
