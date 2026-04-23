/**
 * Настройки веб-приложения для GitHub Pages.
 * Скопируйте значения из src/main/resources/firebase-config.json.
 * В Firebase Console → Authentication → Settings → Authorized domains
 * добавьте: <user>.github.io и при необходимости свой домен.
 */
export const APP_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyCrixbCDYIDnQJy9i-5OqfRBzl-yv6VPCo',
    authDomain: 'lotos-vbinc.firebaseapp.com',
    databaseURL: 'https://lotos-vbinc-default-rtdb.firebaseio.com',
    projectId: 'lotos-vbinc',
    storageBucket: 'lotos-vbinc.firebasestorage.app',
    messagingSenderId: '513984122465',
    appId: '1:513984122465:android:d248db4823f5d46cd5e420',
  },
  /** Индекс тестов на GitHub Pages (как в TestListLoader.java) */
  testsIndexUrl: 'https://inor1loveee.github.io/Lotos/tests/index.json',
  testsBaseUrl: 'https://inor1loveee.github.io/Lotos/tests/',
  /** Единый манифест обновлений (shared with Android) */
  updateManifestUrl: 'https://inor1loveee.github.io/Lotos/update.json',
  appVersionCode: 28,
};
