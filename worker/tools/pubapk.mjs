// Publish the TV APK to Arvan app/TeleTVShare.apk and the in-app update info app/version.json.
// Run from worker/:  node tools/pubapk.mjs <apk> <versionName> <versionCode> <minCode> [notes] [--owner]
//   --owner: publish only to the owner's private channel (app/owner/TeleTVShare.apk + app/version-owner.json);
//            other TVs and the bot's "get the app" button keep the public build.
//   minCode: TV apps with a lower versionCode must update (forced); newer ones get an optional prompt.
// Reads keys from ../.env (never committed). Prints no secrets.
import { AwsClient } from 'aws4fetch';
import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync('../.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const owner = process.argv.includes('--owner');
const [file, version, code, minCode, notes = ''] = process.argv.slice(2).filter((a) => a !== '--owner');
const APK = owner ? 'app/owner/TeleTVShare.apk' : 'app/TeleTVShare.apk';
const INFO = owner ? 'app/version-owner.json' : 'app/version.json';
if (!file || !version || !Number(code) || minCode === undefined) throw new Error('usage: <apk> <name> <code> <minCode> [notes]');
const body = fs.readFileSync(file);
const s3 = new AwsClient({ accessKeyId: env.ARVAN_ACCESS_KEY, secretAccessKey: env.ARVAN_SECRET_KEY, service: 's3', region: env.ARVAN_REGION });
const base = `${env.ARVAN_ENDPOINT}/${env.ARVAN_BUCKET}`;
const put = (key, data, headers) => s3.fetch(`${base}/${key}`, {
  method: 'PUT', body: data, headers: { 'x-amz-acl': 'public-read', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', ...headers },
});

let r = await put(APK, body, {
  'x-amz-meta-version': version, 'content-type': 'application/vnd.android.package-archive',
  'content-disposition': 'attachment; filename="TeleTVShare.apk"',
});
console.log('apk PUT', r.status);
if (!r.ok) process.exit(1);
const info = { code: Number(code), name: version, url: `${env.ARVAN_PUBLIC_URL}/${APK}`, size: body.length, min_code: Number(minCode), notes };
r = await put(INFO, JSON.stringify(info), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache, max-age=0' });
console.log(INFO, 'PUT', r.status, JSON.stringify({ ...info, url: APK }));
for (const k of [APK, INFO]) {
  const p = await fetch(`${env.ARVAN_PUBLIC_URL}/${k}?t=${Date.now()}`, { method: 'HEAD' });
  console.log('public', k, p.status, p.headers.get('content-length'));
}
