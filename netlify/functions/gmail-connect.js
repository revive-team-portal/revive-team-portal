// Starts the Google OAuth flow (one-time connect of the shared mailbox).
// Opening the flow isn't sensitive; only someone who can sign in to the mailbox can complete it.
const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const REDIRECT = 'https://team.revive.co.nz/.netlify/functions/gmail-callback';
const SCOPES = ['openid','email','https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.modify'].join(' ');

exports.handler = async () => {
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
    scope: SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  }).toString();
  return { statusCode: 302, headers: { Location: url }, body: '' };
};
