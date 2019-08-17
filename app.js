const async = require('async');
const noble = require('@abandonware/noble');
const mqtt = require("mqtt");

const MiCipher = require("./MiCipher");

const config = require("./config.json");

const mqttClient = mqtt.connect(config.mqtt.url, {});


const MAC_STRING = config.kettle.mac.toLowerCase();
const ID = config.kettle.id;
const NAME = config.kettle.name;
const ReversedMAC = config.kettle.mac.split(":").map(s => parseInt(s, 16)).reverse();
const ProductId = config.kettle.productid;


mqttClient.on("connect", () => {
    console.log("Connected to broker");

    noble.on('stateChange', function(state) {
        console.log(state);
        if (state === 'poweredOn') {
            noble.startScanning(  [], true);
        } else {
            noble.stopScanning();
        }
    });


    noble.on('discover', function(peripheral) {
        if (peripheral.advertisement.localName === "MiKettle" && peripheral.address === MAC_STRING) {
            noble.stopScanning();

            peripheral.on("disconnect", () => {
                console.info("disconnected");
                mqttClient.publish("kettle/" + ID + "/presence", "offline", {retain: true}, () => {
                    process.exit(0);
                });
            });

            handleKettle(peripheral, (err, data) => {
                console.log("Connected to kettle");

                if(err) {
                    console.error(err);
                } else {
                    let lastStatus = "";

                    mqttClient.publish("homeassistant/sensor/kettle_" + ID + "/config", JSON.stringify({
                        "state_topic": "kettle/" + ID + "/state",
                        "json_attributes_topic": "kettle/" + ID + "/attributes",
                        "ID": NAME,
                        "platform": "mqtt",
                        "unit_of_measurement": "°C",
                        "availability_topic": "kettle/" + ID + "/presence",
                        "icon": "mdi:kettle"
                    }), {retain: true});
                    mqttClient.publish("kettle/" + ID + "/presence", "online", {retain: true});



                    data[CHARACTERISTICS.STATUS].notify(true, err => {
                        if(err) {
                            console.log(err)
                        }
                    });

                    data[CHARACTERISTICS.STATUS].on("data", data => {
                        const parsedData = parseKettleMessage(data);

                        if(JSON.stringify(parsedData) !== lastStatus) {
                            lastStatus = JSON.stringify(parsedData);

                            mqttClient.publish("kettle/" + ID + "/state", parsedData.current_temperature.toString());
                            mqttClient.publish("kettle/" + ID + "/attributes", JSON.stringify({
                                action: parsedData.action,
                                mode: parsedData.mode,
                                keep_warm_temperature: parsedData.keep_warm_set_temperature,
                                keep_warm_type: parsedData.keep_warm_type,
                                keep_warm_time: parsedData.keep_warm_time
                            }));
                        }
                    })
                }
            })


        }
    });
});

["error", "close", "disconnect", "end"].forEach(event => {
    //TODO: Something reasonable
    mqttClient.on(event, (e) => {
        console.error(e);
        process.exit(0);
    })
});

const KEY1 = Buffer.from([0x90, 0xCA, 0x85, 0xDE]);
const KEY2 = Buffer.from([0x92,0xAB,0x54,0xFA]);

const AUTH_SERVICE_ID = "fe95";
const DATA_SERVICE_ID = "01344736000010008000262837236156";

const AUTH_CHARACTERISTICS = {
    INIT: "10",
    AUTH: "1",
    VER: "4"
};

const CHARACTERISTICS = {
    SETUP: "aa01",
    STATUS: "aa02",
    TIME: "aa04",
    BOIL_MODE: "aa05"
};

const KETTLE_MESSAGES = {
    ACTION: {
        0: "Idle",
        1: "Heating",
        2: "Cooling",
        3: "Keeping warm"
    },
    MODE: {
        255: "None",
        1: "Boil",
        2: "Keep Warm"
    },
    KEEP_WARM_TYPE: {
        0: "Boil and cool down",
        1: "Heat to temperature"
    }
};



function handleKettle(peripheral, callback) {
    const Token = Buffer.allocUnsafeSlow(12);
    let authService;
    let dataService;
    let authCharacteristics = {};
    let dataCharacteristics = {};

    async.waterfall([
        function connect(callback) {
            peripheral.connect(callback)
        },
        function serviceDiscovery(callback) {
            peripheral.discoverServices(null, (err, services) => {
                if(!err) {
                    const servicesByID = {};
                    services.forEach(s => servicesByID[s.uuid] = s);

                    if(servicesByID[AUTH_SERVICE_ID] && servicesByID[DATA_SERVICE_ID]) {
                        authService = servicesByID[AUTH_SERVICE_ID];
                        dataService = servicesByID[DATA_SERVICE_ID];

                        callback();
                    } else {
                        callback(new Error("Missing service"));
                    }
                } else {
                    callback(err);
                }
            });
        },
        function authCharacteristicsDiscovery(callback) {
            authService.discoverCharacteristics(null, (err, characteristics) => {
                if(!err) {
                    const cByID = {};
                    characteristics.forEach(c => cByID[c.uuid] = c);

                    if(cByID[AUTH_CHARACTERISTICS.INIT] && cByID[AUTH_CHARACTERISTICS.AUTH] && cByID[AUTH_CHARACTERISTICS.VER]) {
                        authCharacteristics.INIT = cByID[AUTH_CHARACTERISTICS.INIT];
                        authCharacteristics.AUTH = cByID[AUTH_CHARACTERISTICS.AUTH];
                        authCharacteristics.VER = cByID[AUTH_CHARACTERISTICS.VER];
                        callback();
                    } else {
                        callback(new Error("Missing characteristic"));
                    }
                } else {
                    callback(err);
                }
            })
        },
        function authStep1(callback) {
            authCharacteristics.INIT.write(KEY1, true, callback);
        },
        function authStep2(callback) {
            //We have to write 0x01, 0x00 this instead of calling ".subscribe" for.. reasons.
            authCharacteristics.AUTH.write(Buffer.from([0x01, 0x00]), false, err => {
                if(!err) {
                    //STEP 3
                    authCharacteristics.AUTH.on("data", data => {
                        if(MiCipher.cipher(MiCipher.mixB(ReversedMAC, ProductId), MiCipher.cipher(MiCipher.mixA(ReversedMAC, ProductId), data)).compare(Token) === 0) {
                            callback();
                        } else {
                            callback(new Error("Verification failed"))
                        }
                    });

                    //STEP 4
                    authCharacteristics.AUTH.write(MiCipher.cipher(MiCipher.mixA(ReversedMAC, ProductId), Token), err => {
                        if(err) {
                            callback(err);
                        }
                    });
                } else {
                    callback(err);
                }
            });
        },
        function authStep5(callback) {
            authCharacteristics.AUTH.write(MiCipher.cipher(Token, KEY2), true, callback);
        },
        function authStep6(callback) {
            authCharacteristics.VER.read((err, data) => {
                if(!err) {
                    //We have to wait a moment https://github.com/noble/noble/issues/825#issuecomment-416292680
                    setTimeout(() => {
                        callback();
                    }, 100)
                } else {
                    callback(err);
                }
            });
        },
        function dataCharacteristicsDiscovery(callback) {
            dataService.discoverCharacteristics(null, function(err, characteristics){
                if(!err) {
                    if(Array.isArray(characteristics) && characteristics.length === 5) {
                        characteristics.forEach(c => dataCharacteristics[c.uuid] = c);
                        callback();
                    }
                } else {
                    callback(err);
                }
            });
        }
    ], function(err) {
        if(!err) {
            callback(null, dataCharacteristics)
        } else {
            callback(err);
        }
    })
}

function parseKettleMessage(buf) {
    return {
        action: KETTLE_MESSAGES.ACTION[buf.readUInt8(0)],
        mode: KETTLE_MESSAGES.MODE[buf.readUInt8(1)],
        keep_warm_set_temperature: buf.readUInt8(4),
        current_temperature: buf.readUInt8(5),
        keep_warm_type: KETTLE_MESSAGES.KEEP_WARM_TYPE[buf.readUInt8(6)],
        keep_warm_time: buf.readUInt16LE(7)
    };
}