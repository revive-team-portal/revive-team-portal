// Starts the Google OAuth flow. ?mailbox=shared (default, sales) or ?mailbox=cafe (support).
// The chosen mailbox id is round-tripped via the OAuth `state` param.
const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const REDIRECT = 'https://team.revive.co.nz/.netlify/functions/gmail-callback';
const SCOPES = ['openid','email','https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.modify'].join(' ');

exports.handler = async (event) => {
  const mailbox = (event.queryStringParameters && event.queryStringParameters.mailbox) === 'cafe' ? 'cafe' : 'shared';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
    scope: SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: mailbox,
  }).toString();
  return { statusCode: 302, headers: { Location: url }, body: '' };
};
