import { Manager as RootManager, } from "socket.io-client";
import { Socket } from "./rtc";
export class Manager extends RootManager {
    constructor(uri, opts) {
        super(uri, opts);
    }
    socket(nsp, opts) {
        return new Socket(this, nsp, opts);
    }
}
