import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/** The server keeps photos up to 700 KB; base64 adds a third, so the data URL stays under ~950 000 characters. */
const MAX_DATA_URL = 950_000;

/**
 * Takes a photo with the camera (or picks one from the gallery) and returns it as a JPEG data URL
 * small enough for the server: the long side is cut to 1280 px, as in the web app. Null when cancelled.
 */
export async function pickPhoto(source: 'camera' | 'library'): Promise<string | null> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('Нет доступа к камере. Разрешите его в настройках телефона.');
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false };
  const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;

  for (const [side, compress] of [[1280, 0.76], [1024, 0.6], [800, 0.5]] as const) {
    const context = ImageManipulator.manipulate(asset.uri);
    if (Math.max(asset.width, asset.height) > side) context.resize(asset.width >= asset.height ? { width: side } : { height: side });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
    const dataUrl = `data:image/jpeg;base64,${saved.base64}`;
    if (dataUrl.length <= MAX_DATA_URL) return dataUrl;
  }
  throw new Error('Фото слишком большое — попробуйте снять ещё раз');
}
