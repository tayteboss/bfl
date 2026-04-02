import fetch from 'node-fetch';

// Replace these with the values from your Dev Dashboard App Settings
const CLIENT_ID = '03be31d07d7d71b595d03b919d294f75';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'YOUR_CLIENT_SECRET_HERE';

// Replace with your actual store prefix (e.g. "bellows-film-lab")
const STORE_DOMAIN = '1jukgy-dc.myshopify.com';

const FUNCTION_ID = '019d4b56-6ea9-772e-955b-42de58c025cd';

async function run() {
  if (CLIENT_ID === 'YOUR_CLIENT_ID_HERE' || CLIENT_SECRET === 'YOUR_CLIENT_SECRET_HERE') {
    console.error('❌ Please update the CLIENT_ID and CLIENT_SECRET variables in this file first!');
    return;
  }

  console.log('1. Fetching short-lived Admin API token from Dev Dashboard credentials...');

  const tokenParams = new URLSearchParams();
  tokenParams.append('grant_type', 'client_credentials');
  tokenParams.append('client_id', CLIENT_ID);
  tokenParams.append('client_secret', CLIENT_SECRET);

  const tokenRes = await fetch(`https://${STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: tokenParams,
  });

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    console.error('❌ Failed to get access token. Are your Client ID, Secret, and Store Domain correct?');
    console.error(tokenData);
    return;
  }

  console.log('✅ Successfully generated access token.');
  console.log('2. Running GraphQL mutation to activate Cart Transform...');

  const mutation = `
    mutation {
      cartTransformCreate(functionId: "${FUNCTION_ID}") {
        cartTransform {
          id
          functionId
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const gqlRes = await fetch(`https://${STORE_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': tokenData.access_token,
    },
    body: JSON.stringify({ query: mutation }),
  });

  const gqlData = await gqlRes.json();

  if (gqlData.data?.cartTransformCreate?.userErrors?.length > 0) {
    console.error('❌ GraphQL Error:', gqlData.data.cartTransformCreate.userErrors);
  } else if (gqlData.errors) {
    console.error('❌ Network/Auth Error:', gqlData.errors);
  } else {
    console.log('✅ SUCCESS! Cart Transform is now active on your store.');
    console.log(gqlData.data.cartTransformCreate.cartTransform);
  }
}

run();
