"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Manager = void 0;
const socket_io_client_1 = require("socket.io-client");
const rtc_1 = require("./rtc");
class Manager extends socket_io_client_1.Manager {
    constructor(uri, opts) {
        super(uri, opts);
    }
    socket(nsp, opts) {
        return new rtc_1.Socket(this, nsp, opts);
    }
}
exports.Manager = Manager;
