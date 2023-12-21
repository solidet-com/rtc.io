import {
	SocketOptions as RootSocketOptions,
	Socket as RootSocket,
} from "socket.io-client";
import { Manager } from "./manager";

export interface SocketOptions extends Partial<RootSocketOptions> {
	iceServers: RTCIceServer[];
}

export class Socket extends RootSocket {
	constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>) {
		super(io, nsp, opts);
	}

	emit<Ev extends string>(ev: Ev, ...args: any[]): this {
		return super.emit(ev, ...args);
	}

	private _onmediastream = (ev: MessageEvent) => {
		throw new Error("Not implemented");
	};
}
