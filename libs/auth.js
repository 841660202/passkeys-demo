const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { Fido2Lib } = require('fido2-lib');
const { coerceToBase64Url,
        coerceToArrayBuffer
      } = require('fido2-lib/lib/utils');

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('.data/db.json');
const db = low(adapter);

router.use(express.json());

const f2l = new Fido2Lib({
    timeout: 30*1000*60,
    rpId: "webauthn-codelab-resolution.glitch.me", // TODO: Auto generate
    rpName: "WebAuthn Codelab",
    challengeSize: 32,
    cryptoParams: [-7]
});

db.defaults({
  users: []
}).write();

const csrfCheck = (req, res, next) => {
  if (req.header('X-Requested-With') != 'XMLHttpRequest') {
    res.status(400).json({error: 'invalid access.'});
    return;
  }
  next();
};

/**
 * Checks CSRF protection using custom header `X-Requested-With`
 * If cookie doesn't contain `username`, consider the user is not authenticated.
 **/
const sessionCheck = (req, res, next) => {
  if (!req.cookies['signed-in']) {
    res.status(401).json({error: 'not signed in.'});
    return;
  }
  next();
};

/**
 * Check username, create a new account if it doesn't exist.
 * Set a `username` cookie.
 **/
router.post('/username', (req, res) => {
  const username = req.body.username;
  // Only check username, no need to check password as this is a mock
  if (!username) {
    res.status(400).send({ error: 'Bad request' });
    return;
  } else {
    // See if account already exists
    let user = db.get('users')
      .find({ username: username })
      .value();
    // If user entry is not created yet, create one
    if (!user) {
      user = {
        username: username,
        id: coerceToBase64Url(crypto.randomBytes(32), 'user.id'),
        credentials: []
      }
      db.get('users')
        .push(user)
        .write();
    }
    // Set username cookie
    res.cookie('username', username);
    // If sign-in succeeded, redirect to `/home`.
    res.json(user);
  }
});

/**
 * Verifies user credential and let the user sign-in.
 * No preceding registration required.
 * This only checks if `username` is not empty string and ignores the password.
 **/
router.post('/password', (req, res) => {
  if (!req.body.password) {
    res.status(401).json({error: 'Enter at least one random letter.'});
    return;
  }
  const user = db.get('users')
    .find({ username: req.cookies.username })
    .value();
  
  if (!user) {
    res.status(401).json({error: 'Enter username first.'});
    return;
  }

  res.cookie('signed-in', 'yes');
  res.json(user);
});

router.get('/signout', (req, res) => {
  // Remove cookies
  res.clearCookie('username');
  res.clearCookie('signed-in');
  // Redirect to `/`
  res.redirect(302, '/');
});

/**
 * Returns a credential id
 * (This server only stores one key per username.)
 * Response format:
 * ```{
 *   username: String,
 *   credentials: [Credential]
 * }```
 
 Credential
 ```
 {
   credId: String,
   publicKey: String,
   aaguid: ??,
   prevCounter: Int
 };
 ```
 **/
router.post('/getKeys', csrfCheck, sessionCheck, (req, res) => {
  const user = db.get('users')
    .find({ username: req.cookies.username })
    .value();
  res.json(user || {});
});

/**
 * Removes a credential id attached to the user
 * Responds with empty JSON `{}`
 **/
router.post('/removeKey', csrfCheck, sessionCheck, (req, res) => {
  const credId = req.query.credId;
  const username = req.cookies.username;
  const user = db.get('users')
    .find({ username: username })
    .value();

  const newCreds = user.credentials.filter(cred => {
    // Leave credential ids that do not match
    return cred.credId !== credId;
  });

  db.get('users')
    .find({ username: username })
    .assign({ credentials: newCreds })
    .write();

  res.json({});
});

router.get('/resetDB', (req, res) => {
  db.set('users', []).write();
  const users = db.get('users').value();
  res.json(users);
});

/**
 * Respond with required information to call navigator.credential.create()
 * Input is passed via `req.body` with similar format as output
 * Output format:
 * ```{
     rp: {
       id: String,
       name: String
     },
     user: {
       displayName: String,
       id: String,
       name: String
     },
     publicKeyCredParams: [{  // @herrjemand
       type: 'public-key', alg: -7
     }],
     timeout: Number,
     challenge: String,
     excludeCredentials: [{
       id: String,
       type: 'public-key',
       transports: [('ble'|'nfc'|'usb'|'internal'), ...]
     }, ...],
     authenticatorSelection: {
       authenticatorAttachment: ('platform'|'cross-platform'),
       requireResidentKey: Boolean,
       userVerification: ('required'|'preferred'|'discouraged')
     },
     attestation: ('none'|'indirect'|'direct')
 * }```
 **/
router.post('/registerRequest', csrfCheck, sessionCheck, async (req, res) => {
  const username = req.cookies.username;
  const user = db.get('users')
    .find({ username: username })
    .value();
  try {
    const response = await f2l.attestationOptions();
    response.user = {
      displayName: 'No name',
      id: user.id,
      name: user.username
    };
    response.challenge = coerceToBase64Url(response.challenge, 'challenge');
    res.cookie('challenge', response.challenge);
    response.excludeCredentials = [];
    if (user.credentials.length > 0) {
      for (let cred of user.credentials) {
        response.excludeCredentials.push({
          id: cred.credId,
          type: 'public-key',
          transports: ['internal']
        });
      }
    }
    const as = {}; // authenticatorSelection
    const aa = req.body.authenticatorSelection.authenticatorAttachment;
    const rr = req.body.authenticatorSelection.requireResidentKey;
    const uv = req.body.authenticatorSelection.userVerification;
    const cp = req.body.attestation; // attestationConveyancePreference
    let asFlag = false;

    if (aa && (aa == 'platform' || aa == 'cross-platform')) {
      asFlag = true;
      as.authenticatorAttachment = aa;
    }
    if (rr && typeof rr == 'boolean') {
      asFlag = true;
      as.requireResidentKey = rr;
    }
    if (uv && (uv == 'required' || uv == 'preferred' || uv == 'discouraged')) {
      asFlag = true;
      as.userVerification = uv;
    }
    if (asFlag) {
      response.authenticatorSelection = as;
    }
    if (cp && (cp == 'none' || cp == 'indirect' || cp == 'direct')) {
      response.attestation = cp;
    }

    res.json(response);
  } catch (e) {
    res.status(400).send({ error: e });
  }
});

/**
 * Register user credential.
 * Input format:
 * ```{
     id: String,
     type: 'public-key',
     rawId: String,
     response: {
       clientDataJSON: String,
       attestationObject: String,
       signature: String,
       userHandle: String
     }
 * }```
 **/
router.post('/registerResponse', csrfCheck, sessionCheck, async (req, res) => {
  const username = req.cookies.username;
  const challenge = coerceToArrayBuffer(req.cookies.challenge, 'challenge');
  const credId = req.body.id;
  const type = req.body.type;

  try {
    const clientAttestationResponse = { response: {} };
    clientAttestationResponse.rawId =
      coerceToArrayBuffer(req.body.rawId, "rawId");
    clientAttestationResponse.response.clientDataJSON =
      coerceToArrayBuffer(req.body.response.clientDataJSON, "clientDataJSON");
    clientAttestationResponse.response.attestationObject =
      coerceToArrayBuffer(req.body.response.attestationObject, "attestationObject");

    let origin = '';
    if (req.get('User-Agent').indexOf('okhttp') > -1) {
      origin = `android:apk-key-hash:lvddYHnbc_TT-5QSitlDFu7t5I_Wh7f263uB_avskuc`; // TODO: Generate
    } else {
      origin = `https://${req.get('host')}`;
    }

    const attestationExpectations = {
      challenge: challenge,
      origin: origin,
      factor: "either"
    };

    const regResult = await f2l.attestationResult(clientAttestationResponse, attestationExpectations);

    const credential = {
      credId: coerceToBase64Url(regResult.authnrData.get("credId"), 'credId'),
      publicKey: regResult.authnrData.get("credentialPublicKeyPem"),
      aaguid: regResult.authnrData.get("aaguid"),
      prevCounter: regResult.authnrData.get("counter")
    };

    const user = db.get('users')
      .find({ username: username })
      .value();

    user.credentials.push(credential);

    db.get('users')
      .find({ username: username })
      .assign(user)
      .write();

    res.clearCookie('challenge');

    // Respond with user info
    res.json(user);
  } catch (e) {
    res.clearCookie('challenge');
    res.status(400).send({ error: e.message });
  }
});

/**
 * Respond with required information to call navigator.credential.get()
 * Input is passed via `req.body` with similar format as output
 * Output format:
 * ```{
     challenge: String,
     userVerification: ('required'|'preferred'|'discouraged'),
     allowCredentials: [{
       id: String,
       type: 'public-key',
       transports: [('ble'|'nfc'|'usb'|'internal'), ...]
     }, ...]
 * }```
 **/
router.post('/signinRequest', csrfCheck, async (req, res) => {
  try {
    const user = db.get('users')
      .find({ username: req.cookies.username })
      .value();
    
    if (!user) {
      // Send empty response if user is not registered yet.
      res.json({error: 'User not found.'});
      return;
    }
    
    const credId = req.query.credId;

    const response = await f2l.assertionOptions();

    // const response = {};
    response.userVerification = req.body.userVerification || 'preferred';
    response.challenge = coerceToBase64Url(response.challenge, 'challenge');
    res.cookie('challenge', response.challenge);

    response.allowCredentials = [];

    if (credId) {
      for (let cred of user.credentials) {
        if (cred.credId == credId) {
          response.allowCredentials.push({
            id: cred.credId,
            type: 'public-key',
            transports: ['internal']
          });
        }
      }
    }

    res.json(response);
  } catch (e) {
    res.status(400).json({ error: e });
  }
});

/**
 * Authenticate the user.
 * Input format:
 * ```{
     id: String,
     type: 'public-key',
     rawId: String,
     response: {
       clientDataJSON: String,
       authenticatorData: String,
       signature: String,
       userHandle: String
     }
 * }```
 **/
router.post('/signinResponse', csrfCheck, async (req, res) => {
  // Query the user
  const user = db.get('users')
    .find({ username: req.cookies.username })
    .value();

  let credential = null;
  for (let cred of user.credentials) {
    if (cred.credId === req.body.id) {
      credential = cred;
    }
  }

  try {
    if (!credential) {
      throw 'Authenticating credential not found.';
    }

    const challenge = coerceToArrayBuffer(req.cookies.challenge, 'challenge');
    const origin = `https://${req.get('host')}`; // TODO: Temporary work around for scheme
    
    const clientAssertionResponse = { response: {} };
    clientAssertionResponse.rawId =
      coerceToArrayBuffer(req.body.rawId, "rawId");
    clientAssertionResponse.response.clientDataJSON =
      coerceToArrayBuffer(req.body.response.clientDataJSON, "clientDataJSON");
    clientAssertionResponse.response.authenticatorData =
      coerceToArrayBuffer(req.body.response.authenticatorData, "authenticatorData");
    clientAssertionResponse.response.signature =
      coerceToArrayBuffer(req.body.response.signature, "signature");
    clientAssertionResponse.response.userHandle =
      coerceToArrayBuffer(req.body.response.userHandle, "userHandle");
    const assertionExpectations = {
      challenge: challenge,
      origin: origin,
      factor: "either",
      publicKey: credential.publicKey,
      prevCounter: credential.prevCounter,
      userHandle: coerceToArrayBuffer(user.id, 'userHandle')
    };
    const result = await f2l.assertionResult(clientAssertionResponse, assertionExpectations);

    credential.prevCounter = result.authnrData.get("counter");

    db.get('users')
      .find({ id: req.cookies.id })
      .assign(user)
      .write();

    res.clearCookie('challenge');
    res.cookie('signed-in', 'yes');
    res.json(user);
  } catch (e) {
    res.clearCookie('challenge');
    res.status(400).json({ error: e });
  }
});

module.exports = router;
