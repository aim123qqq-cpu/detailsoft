import * as SecureStore from 'expo-secure-store';

// The server address and the session token live in the Android keystore-backed secure storage.
const SERVER = 'detailflow.server';
const TOKEN = 'detailflow.session';

export const storage = {
  server: () => SecureStore.getItemAsync(SERVER),
  setServer: (url: string) => SecureStore.setItemAsync(SERVER, url),
  token: () => SecureStore.getItemAsync(TOKEN),
  setToken: (token: string) => SecureStore.setItemAsync(TOKEN, token),
  clearToken: () => SecureStore.deleteItemAsync(TOKEN)
};
