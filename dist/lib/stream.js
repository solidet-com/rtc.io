"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RTCIOStream = void 0;
const uuid_1 = require("uuid");
class RTCIOStream {
    constructor(idOrMediaStream, mediaStream) {
        console.log(idOrMediaStream, idOrMediaStream instanceof MediaStream);
        if (idOrMediaStream instanceof MediaStream) {
            this.id = (0, uuid_1.v4)();
            this.mediaStream = idOrMediaStream;
        }
        else {
            this.id = idOrMediaStream;
            this.mediaStream = mediaStream;
        }
    }
    replace(stream) { }
    toJSON() {
        return `[RTCIOStream] ${this.id}`;
    }
}
exports.RTCIOStream = RTCIOStream;
