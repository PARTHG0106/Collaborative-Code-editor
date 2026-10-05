The D1 loopback TLS certificate and private key are **public test fixtures**.
They are not production credentials and must never be used outside tests.

The certificate names `api.cloudflare.com` so the transport's fixed endpoint
can be verified through a local CONNECT proxy without external network access.
Only the test agent trusts it; normal certificate validation remains enabled.

To replace the fixtures, run from the repository root:

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout apps/server/src/lib/__fixtures__/d1-loopback-key.pem \
  -out apps/server/src/lib/__fixtures__/d1-loopback-cert.pem \
  -days 3650 -subj '/CN=api.cloudflare.com' \
  -addext 'subjectAltName=DNS:api.cloudflare.com'
```
