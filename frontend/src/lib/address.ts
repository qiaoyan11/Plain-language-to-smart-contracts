/** "0x7099…79C8": enough to recognise an address; show the full one in a tooltip or details. */
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
