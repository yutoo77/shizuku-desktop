export const MAX_MODEL_BYTES = 100 * 1024 * 1024;
// GLB only, with all buffers/images embedded. No model-supplied file or web URLs.
export function validateModel(buffer) {
  if (buffer.byteLength < 20 || buffer.byteLength > MAX_MODEL_BYTES) throw new Error('VRMは100MB以下のGLB形式にしてください。');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength) throw new Error('VRMファイルの形式が正しくありません。');
  const length = view.getUint32(12, true);
  if (length > buffer.byteLength - 20 || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('VRMの情報を読めません。');
  const json = JSON.parse(new TextDecoder().decode(buffer.subarray(20, 20 + length)));
  if (!json.extensions?.VRMC_vrm && !json.extensions?.VRM) throw new Error('VRMモデルではありません。');
  for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (entry.uri !== undefined) throw new Error('外部ファイルを参照するVRMは読み込めません。');
  }
  return json;
}
