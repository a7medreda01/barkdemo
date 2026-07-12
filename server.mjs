import { reqHandler } from '../dist/app/server/server.mjs';

export default function handler(req, res) {
  return reqHandler(req, res);
}