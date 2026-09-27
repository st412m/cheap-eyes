// All secrets below are fake, built for the tests. scan-secrets:allow-file
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSecretKey, keySegments, Masker } from '../src/mask.js';

function mask(text, extra) {
  const m = new Masker(extra);
  return { out: m.maskText(text), counts: m.counts };
}

const CASES = [
  ['uuid', 'id 123e4567-e89b-12d3-a456-426614174000 x', 'id [uuid] x'],
  ['base64_43', 'peer yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk= end', 'peer [key] end'],
  // Standard base64 starts with "/" about once in 64 keys.
  ['base64_43', 'peer /Anz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk= end', 'peer [key] end'],
  ['base64_43', 'PublicKey=/Anz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=', 'PublicKey=[key]'],
  ['kv_secret', 'PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=', 'PrivateKey = [token]'],
  ['base64_43', 'pbk kYHfIV2MRt2Q1CrBjCqDMS8d0rPJFqd7kFb5x3fx0A0 end', 'pbk [key] end'],
  ['hex32', 'hash d41d8cd98f00b204e9800998ecf8427e end', 'hash [id] end'],
  ['mixed_alnum', 'tok AbCdEfGhIjKlMnOpQrStUvWxYz0123 end', 'tok [token] end'],
  ['sk_key', 'key sk-or-v1-0123456789abcdef0123456789abcdef', 'key [key]'],
  ['sk_key', 'key sk-FAKEfake0123456789', 'key [key]'],
  ['github_token', 'ghp_FAKEfakeFAKEfake0123456789abcd', '[token]'],
  ['github_token', 'github_pat_FAKE0123456789_fakeFAKEfake', '[token]'],
  ['jwt', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk', 'jwt [token]'],
  ['telegram_bot_token', 'bot 123456789:AAEhBP0av18dW3HfzX7xY0123456789abcd done', 'bot [token] done'],
  ['bearer', 'Bearer abcdefgh12345', 'Bearer [token]'],
  ['auth_header', 'Authorization: Basic dXNlcjpwYXNz', 'Authorization: [token]'],
  ['auth_header', 'curl -H "Authorization: Bearer abc.def.ghi"', 'curl -H "Authorization: [token]"'],
  ['kv_secret', '"db_password": "hunter2", "user": "bob"', '"db_password": "[token]", "user": "bob"'],
  ['kv_secret', "api_key: 'xyz' # c", "api_key: '[token]' # c"],
  ['kv_secret', 'export GITHUB_TOKEN=abc123', 'export GITHUB_TOKEN=[token]'],
  ['kv_secret', 'password = my pass phrase # comment', 'password = [token] # comment'],
  ['kv_secret', 'Client_Secret: s3cr3t', 'Client_Secret: [token]'],
  ['kv_secret', '  mqtt_passwd: hello', '  mqtt_passwd: [token]'],
  ['kv_secret', 'PRIVATE_KEY="abc"', 'PRIVATE_KEY="[token]"'],
  ['kv_secret', "'api-key': 'v'", "'api-key': '[token]'"],
  ['kv_secret', 'bot_token: abc', 'bot_token: [token]'],
  ['kv_secret', '{"accessToken":"abc"}', '{"accessToken":"[token]"}'],
  ['kv_secret', 'apiKey = "abc"', 'apiKey = "[token]"'],
  ['kv_secret', 'APIKey: abc', 'APIKey: [token]'],
  ['kv_secret', 'x-api-key: abc', 'x-api-key: [token]'],
  ['kv_secret', 'client_secret=abc', 'client_secret=[token]'],
  ['kv_secret', 'private_key: abc', 'private_key: [token]'],
  ['kv_secret', 'apikey: abc', 'apikey: [token]'],
  ['kv_secret', 'db_password2: abc', 'db_password2: [token]'],
  ['kv_secret', 'pwd: abc', 'pwd: [token]'],
  ['url_userinfo', 'https://user:pa55@example.com/x', 'https://[token]@example.com/x'],
  ['url_userinfo', 'git clone https://tok3n@example.com/r.git', 'git clone https://[token]@example.com/r.git'],
  ['url_userinfo', 'ss://YWVzLTI1Ni1nY206cGFzcw==@198.51.100.7:8388#tag', 'ss://[token]@198.51.100.7:8388#tag'],
  ['url_query', 'vless://x@example.com:443?security=reality&sid=6ba85179&pbk=abcXYZ&fp=chrome', 'vless://[token]@example.com:443?security=reality&sid=[id]&pbk=[key]&fp=chrome'],
];

for (const [name, input, expected] of CASES) {
  test(`mask ${name}: ${input.slice(0, 40)}`, () => {
    const { out, counts } = mask(input);
    assert.equal(out, expected);
    assert.ok(counts[name] >= 1, `counted under ${name}: ${JSON.stringify(counts)}`);
  });
}

test('PEM block body is masked, BEGIN/END kept, one count per block', () => {
  const text = 'a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nz';
  const { out, counts } = mask(text);
  assert.equal(out, 'a\n-----BEGIN OPENSSH PRIVATE KEY-----\n[key]\n[key]\n-----END OPENSSH PRIVATE KEY-----\nz');
  assert.equal(counts.pem, 1);
});

test('PEM body lines are masked even when only part of the block is selected', () => {
  const lines = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEow', 'AAAA', '-----END RSA PRIVATE KEY-----'];
  const m = new Masker();
  const out = m.maskLines(lines, [2]);
  assert.equal(out.get(2), '[key]');
  assert.equal(m.counts.pem, 1);
});

test('existing masks stay as they are and are not counted', () => {
  for (const s of ['password: [token]', 'client_secret: <SECRET>', 'Authorization: [token]', 'https://[token]@example.com', 'password: !secret db_password', 'token: null']) {
    const { out, counts } = mask(s);
    assert.equal(out, s);
    assert.deepEqual(counts, {});
  }
});

test('a token inside a key-value pair is masked once', () => {
  const { out, counts } = mask('api_key: sk-or-v1-0123456789abcdef0123456789abcdef');
  assert.equal(out, 'api_key: [key]');
  assert.deepEqual(counts, { sk_key: 1 });
});

test('key names are compared by segments, not substrings', () => {
  for (const s of ['max_tokens: 4096', 'tokenizer: bpe', 'PWD=/home/example', 'OLDPWD=/tmp', 'passwords_count: 3', 'secretary: Ann', 'keyword: api', 'api_version: 2', 'monkey: 1']) {
    assert.equal(mask(s).out, s, s);
  }
  assert.deepEqual(keySegments('myAPIKey'), ['my', 'api', 'key']);
  assert.deepEqual(keySegments('db.password-2'), ['db', 'password', '2']);
});

test('a "key" segment is secret with api|access|private|secret|client|auth anywhere in the name', () => {
  for (const k of ['api_access_key', 'access_key', 'auth_key', 'AccessKey', 'accesskey', 'key_api', 'client_key', 'secret_key_id']) {
    assert.equal(isSecretKey(k), true, k);
  }
  for (const k of ['cache_key', 'sort_key', 'primary_key', 'keyboard', 'monkey', 'key', 'api_version', 'access_log']) {
    assert.equal(isSecretKey(k), false, k);
  }
  assert.equal(mask('aws_access_key: AKIAFAKE').out, 'aws_access_key: [token]');
  assert.equal(mask('sort_key: name').out, 'sort_key: name');
});

test('YAML block scalar under a secret key: indented body masked, key line kept', () => {
  const text = [
    'service:',
    '  private_key: |',
    '    MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    '',
    '    second line of the secret',
    '  user: bob',
    '  password: >-',
    '    folded secret',
    'next: 1',
    '  description: |',
    '    not a secret',
  ].join('\n');
  const { out, counts } = mask(text);
  assert.equal(
    out,
    [
      'service:',
      '  private_key: |',
      '    [token]',
      '',
      '    [token]',
      '  user: bob',
      '  password: >-',
      '    [token]',
      'next: 1',
      '  description: |',
      '    not a secret',
    ].join('\n'),
  );
  assert.equal(counts.kv_secret, 2);
});

test('YAML block in a list item: body indent is measured from the key', () => {
  const { out } = mask('- token: |\n    abc\n- name: x');
  assert.equal(out, '- token: |\n    [token]\n- name: x');
});

test('extra patterns from config', () => {
  const { out, counts } = mask('customer ACME-000123 here', ['ACME-\\d{6}']);
  assert.equal(out, 'customer [token] here');
  assert.equal(counts.extra_1, 1);
});

test('false positives survive', () => {
  const keep = [
    'commit 356a192 fixed it',
    'sha 356a192b7913b04c54574d18c28d46e6395428ab',
    'mac aa:bb:cc:dd:ee:ff and AA-BB-CC-DD-EE-FF',
    'ip 192.0.2.10 and 2001:db8::1 port 198.51.100.7:8123',
    'version 2026.9.1 and v1.2.3-beta',
    'date 2026-09-26 12:00:00.123 and 26.09.2026',
    'path /usr/lib/python3.13/site-packages/homeassistant/components/x.py',
    'C:\\Users\\example\\AppData\\Local\\cheap-eyes\\results',
    'entity sensor.living_room_temperature_humidity_combined',
    'plain words and numbers 1234567890',
    'HomeAssistantConfigFlowHandlerForTheIntegration',
  ];
  for (const s of keep) assert.equal(mask(s).out, s, s);
});

test('masking never changes the number of lines', () => {
  const text = 'a\npassword: x\n-----BEGIN X-----\nq\n-----END X-----\n';
  assert.equal(mask(text).out.split('\n').length, text.split('\n').length);
});
