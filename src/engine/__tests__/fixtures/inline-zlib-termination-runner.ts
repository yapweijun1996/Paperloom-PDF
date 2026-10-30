import { zlibEncodedLength } from '../../parser/filters';
try {
  zlibEncodedLength(new Uint8Array([0x78, 0x9c, 0x05, 0, 0, 0, 0, 0, 0, 0, 0]));
  throw new Error('Invalid tree was accepted');
} catch (error) {
  if (!(error instanceof Error) || !/Invalid Huffman tree/.test(error.message)) throw error;
  console.log('invalid tree rejected');
}
