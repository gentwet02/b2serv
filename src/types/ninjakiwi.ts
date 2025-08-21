export type NkApi = `https://data.ninjakiwi.com/battles2/${string}`;

export interface NinjaKiwiResponse<T> {
    body: T;
    next?: boolean;
}

export interface Model {
    /** The internal name of the model */
    name: string;
    /** All the different key:value of the model */
    parameters: { ['string']: string };
}
