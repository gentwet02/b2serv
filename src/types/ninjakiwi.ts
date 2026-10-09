export type NkApi = `https://data.ninjakiwi.com/battles2/${string}`;

export interface NinjaKiwiResponse<T> {
    body: T;
    next?: boolean;
}

export interface Model {
    name: string;
    parameters: { [key: string]: string };
}
