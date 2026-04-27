import { RTCIOChannel } from "./channel";
type Listener = (...args: any[]) => void;
export declare class RTCIOBroadcastChannel {
    private _peers;
    private _globalListeners;
    private _closed;
    _addPeer(peerId: string, channel: RTCIOChannel): void;
    _removePeer(peerId: string): void;
    emit(eventName: string, payload?: any): void;
    send(data: ArrayBuffer | string): boolean;
    on(event: string, handler: Listener): this;
    off(event: string, handler: Listener): this;
    once(event: string, handler: Listener): this;
    close(): void;
    get peerCount(): number;
    get closed(): boolean;
    private _dispatch;
}
export {};
