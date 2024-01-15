type BasePayload = {
	source: string;
	target: string;
};

export type MessagePayload<T = any> = {
	data: T;
} & BasePayload;
