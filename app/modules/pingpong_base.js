const BaseModule = require('./baseModule');

class PingpongBase extends BaseModule {
    constructor(cubeCnt) {
        super();

        this.readValue = {};
        this.send_cmd = {};
        this.cmd_seq = 0;

        this.isDraing = false;
        this.sendBuffer = [];

        this.sp = null;
        this.isCubeConnecting = false;
        this.isCheckConnecting = false;
        this.isConnected = false;
        this.useNotification = false;

        this.cubeCount = cubeCnt || 2;
        this.checkBuffer = null;

        console.log('PINGPONG construct : G%d', this.cubeCount);
    }

    makePackets(method, grpid = 0) {
        //console.log('..make_packet: ' + method);

        // CUBE_ID[0:3] / ASSIGNED_ID[4:5] / OPCODE[6] / SIZE[7:8] / OPT[9..11]
        // virtual

        let result = null;
        if (method === 'connect') {
            result = Buffer.from([
                0xdd,
                0xdd,
                grpid,
                0x00,
                0x00,
                0x00,
                0xda,
                0x00,
                0x0b,
                0x00,
                0x00,
            ]);
            //result[2] = this.groupId;
        } else if (method === 'disconnect') {
            result = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0xa8, 0x00, 0x0a, 0x01]);
            //result = Buffer.from('ffffffff0000a8000a01', 'hex');
        } else if (method === 'checkdongle') {
            result = Buffer.from([
                0xdd, 0xdd, 0xdd, 0xdd, 0x00, 0x01, 0xda, 0x00, 0x0b, 0x00, 0x0d,
            ]);
        } else if (method === 'setMultirole') {
            result = Buffer.from([
                0xff,
                0xff,
                0x00,
                0xff,
                this.cubeCount << 4,
                0x00,
                0xad,
                0x00,
                0x0b,
                0x0a,
                0x00,
            ]);
            if (grpid > 0) {
                result[2] = grpid;
                result[9] = 0x1a;
                result[10] = grpid;
            }
        } else if (method === 'getSensorData') {
            result = Buffer.from([
                0xff,
                0xff,
                0xff,
                0xff, // position
                0x00,
                0xc8, // continuous sampling
                0xb8,
                0x00,
                0x0b,
                30, // interval
                0x01,
            ]);
        }
        return result;
    }

    isPingpongConnected(packet) {}

    setSerialPort(sp) {
        this.sp = sp;
    }

    // 연결 후 초기에 송신할 데이터가 필요한 경우 사용합니다.
    requestInitialData(sp, payload) {
        //console.log('P:requestInitialData: ');
        const grpid = payload.match(/[0-7]{1,2}$/g);
        if (grpid == null) {
            console.warn('Wrong group id inputted', payload);
            return null;
        }
        const grpno = parseInt(grpid[0], 16);
        return this.makePackets('setMultirole', grpno);
    }

    dbgHexstr(data) {
        let output = '';
        data.map((item) => {
            let number = item.toString(16);
            if (number.length < 2) {
                number = `0${number}`;
            }
            output += `${number},`;
        });
        return output;
    }

    // 연결 후 초기에 수신받아서 정상연결인지를 확인해야하는 경우 사용합니다.
    checkInitialData(data, config) {
        console.log('P:checkInitialData: /  data(%d)', data.length);

        if (this.checkBuffer) {
            this.checkBuffer = Buffer.concat([this.checkBuffer, data]);
        } else {
            this.checkBuffer = Buffer.from(data);
        }

        const payload = this.checkBuffer;

        if (payload.length >= 9) {
            const packetSize = payload.readInt16BE(7);
            if (payload.length >= packetSize) {
                const packet = payload.slice(0, packetSize);
                console.log('PACKET: ', packetSize);

                if (this.isPingpongConnected(packet) == true) {
                    console.info('checkInitialData(): all cube connected!');
                    return true;
                }

                // skip this packet
                this.checkBuffer = Buffer.from(payload.slice(packetSize));
                console.log('After skip: ', this.checkBuffer);
                return;
            }
        }
    }

    // optional. 하드웨어에서 받은 데이터의 검증이 필요한 경우 사용합니다.
    validateLocalData(data) {
        //console.log('P:validateLocalData: '+data.length);
        return true;
    }

    // 엔트리에서 받은 데이터에 대한 처리
    handleRemoteData(handler) {
        this.send_cmd = handler.read('COMMAND');
        if (this.send_cmd) {
            //console.log('P:handleRemoteData: ', this.send_cmd);
            if (this.send_cmd.id == -1) {
                this.cmd_seq = 0;
                //console.log('P:handleRemoteData RD: CLEAR');
            } else if (this.send_cmd.id != this.cmd_seq) {
                this.cmd_seq = this.send_cmd.id;
                this.sendBuffer.push(Buffer.from(this.send_cmd.data));
                //const sendBuffer = Buffer.from(this.send_cmd.data);
            }
        }
    }

    // 하드웨어 기기에 전달할 데이터
    requestLocalData() {
        const self = this;
        if (!this.isDraing && this.sendBuffer.length > 0) {
            this.isDraing = true;
            const msg = this.sendBuffer.shift();
            //console.log('P:requestLocalData() : ', msg, this.sendBuffer.length);
            this.sp.write(msg, () => {
                if (self.sp) {
                    self.sp.drain(() => {
                        self.isDraing = false;
                    });
                }
            });
        }

        return null;
    }

    // 하드웨어에서 온 데이터 처리
    handleLocalData(data) {
        //console.log('P:handle LocalData:(%d) %s ', data.length, this.dbgHexstr(data));
        if (!this.isConnected) {
        }

        if (data.length >= 9) {
            const packetSize = data.readInt16BE(7);
            const opcode = data[6];

            if (data.length >= packetSize && packetSize >= 19) {
                if (opcode == 0xb8 && data[5] == 0xc8) {
                    const cubeid = data[3];
                    if (cubeid >= this.cubeCount) {
                        return;
                    }
                    const sensor = this._sensorData[cubeid];

                    sensor.MOVE_X = data.readInt8(12);
                    sensor.MOVE_Y = data.readInt8(13);
                    sensor.MOVE_Z = data.readInt8(14);

                    const xx = Math.max(Math.min(data.readInt8(15), 90), -90);
                    let yy = Math.max(Math.min(data.readInt8(16), 90), -90);
                    yy *= -1;
                    const zz = Math.max(Math.min(data.readInt8(17), 90), -90);
                    sensor.TILT_X = xx;
                    sensor.TILT_Y = yy;
                    sensor.TILT_Z = zz;

                    sensor.BUTTON = data[11];

                    sensor.PROXIMITY = data.readUInt8(18);

                    // 기존 FW 70 버전 = data length 19 bytes (ANALOG IN 미지원)
                    if (packetSize > 19) {
                        sensor.AIN = data.readUInt8(19) * 4;
                    } else {
                        sensor.AIN = 0;
                    }

                    //XXX: sensor data 묶어서 보낼 경우 사용
                    //this.readValue.SENSOR = sensor;

                    /*
				this._proximity.C1Prox = PingPongUtil.getUnsignedIntfromByteData(value[18]);
				this._proximity.C1ProxInterVal = this._proximity.C1Prox - this._proximity.C1ProxOld;
				this._proximity.C1ProxOld = this._proximity.C1Prox;
				*/
                }
            } else {
                //TODO: 기타 응답 패킷 처리 필요부분 추가
                //console.log('P:Board Data: %s ', this.dbgHexstr(data));
            }
        }
    }

    // 엔트리로 전달할 데이터
    requestRemoteData(handler) {
        //console.log('P:request RD: ');
        const self = this;
        Object.keys(this.readValue).forEach((key) => {
            if (self.readValue[key] !== undefined) {
                handler.write(key, self.readValue[key]);
            }
        });

        //XXX: entryjs의 monitorTemplate 사용하려면 트리상단에 PORT 정보 보내야함
        for (let cubeid = 0; cubeid < this.cubeCount; cubeid++) {
            const sdata = this._sensorData[cubeid];
            Object.keys(sdata).forEach((key) => {
                if (sdata[key] !== undefined) {
                    //console.log(" --handler.write (%s) = %j ", key, self._sensorData[key]);
                    handler.write(`c${cubeid.toString()}_${key}`, sdata[key]);
                }
            });
        }
    }

    connect() {
        console.log('P: connect: ');

        setTimeout(() => {
            this.sp.write(this.makePackets('getSensorData'), (err) => {
                console.log('done.........');
            });
        }, 500);
    }

    // 하드웨어 연결 해제 시 호출됩니다.
    disconnect(connect) {
        console.log('P:disconnect: ');

        //console.log('.. ', this.sp.isOpen);
        if (this.sp) {
            // set led
            //this.sp.write( Buffer.from('ffffffff0000ce000e0200000150', 'hex') );
            // getSensor disable
            //this.sp.write( Buffer.from('ffffffff00c8b8000b0001', 'hex') );

            this.sp.write(this.makePackets('disconnect'), (err) => {
                if (this.sp.isOpen) {
                    console.log('Disconnect');
                    connect.close();
                }
                this.sp = null;
            });
        } else {
            connect.close();
        }
    }

    // 엔트리와의 연결 종료 후 처리 코드입니다.
    reset() {
        //console.log('P:reset: ');
    }
}

module.exports = PingpongBase;
