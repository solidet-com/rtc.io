export declare const HIGH_WATERMARK = 16777216;
export declare const LOW_WATERMARK = 1048576;
export declare const QUEUE_BUDGET = 1048576;
export interface ChannelOptions {
    ordered?: boolean;
    maxRetransmits?: number;
    maxPacketLifeTime?: number;
    queueBudget?: number;
}
type Listener = (...args: any[]) => void;
export declare class RTCIOChannel {
    private _dc;
    private _listeners;
    private _queue;
    private _queueBytes;
    private readonly _queueBudget;
    constructor(queueBudget?: number);
    _attach(dc: RTCDataChannel): void;
    _isAttached(): boolean;
    emit(eventName: string, ...args: any[]): void;
    send(data: ArrayBuffer | string): boolean;
    on(event: string, handler: Listener): this;
    off(event: string, handler: Listener): this;
    once(event: string, handler: Listener): this;
    close(): void;
    get readyState(): RTCDataChannelState;
    get bufferedAmount(): number;
    _dispatchLocal(event: string, ...args: any[]): void;
    private _write;
    private _enqueue;
    private _flush;
}
export {};
