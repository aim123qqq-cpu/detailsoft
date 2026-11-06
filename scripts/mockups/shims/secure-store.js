// For the browser build of mockups only: the token and the server come from the page, not the Android keystore.
export const getItemAsync = async (key) => key === 'detailflow.server' ? window.location.origin : window.localStorage.getItem(key);
export const setItemAsync = async (key, value) => { if (key !== 'detailflow.server') window.localStorage.setItem(key, value); };
export const deleteItemAsync = async (key) => window.localStorage.removeItem(key);
