// zsLabTuB3 Oracle (zsT3): YouTube engagement mint oracle with on-chain emit, subscriber/view logging, and treasury-aware tokenomics

require('dotenv').config();
const { JsonRpcProvider, Wallet, Contract } = require('ethers');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const CHANNEL_ID = process.env.CHANNEL_ID;
const API_KEY = process.env.API_KEY;

const provider = new JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);
const contractABI = require('../zTuB3-Diamondz-Contract/upgradeable-token/abi.json');
const contract = new Contract(CONTRACT_ADDRESS, contractABI, wallet);

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/datastore'],
});

async function getLatestVideos(channelId, apiKey) {
  const res = await axios.get(`https://www.googleapis.com/youtube/v3/search`, {
    params: {
      part: 'snippet',
      channelId,
      order: 'date',
      maxResults: 10,
      type: 'video',
      key: apiKey,
    },
  });
  return res.data.items;
}

async function getVideoStats(videoId, apiKey) {
  const res = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, {
    params: {
      part: 'statistics',
      id: videoId,
      key: apiKey,
    },
  });
  return res.data.items[0]?.statistics || {};
}

async function getSubscriberCount(channelId, apiKey) {
  const res = await axios.get(`https://www.googleapis.com/youtube/v3/channels`, {
    params: {
      part: 'statistics',
      id: channelId,
      key: apiKey,
    },
  });
  return parseInt(res.data.items[0]?.statistics?.subscriberCount || '0');
}

async function updateFirestore(videoId, views) {
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const url = `https://firestore.googleapis.com/v1/projects/diamond-zminter/databases/(default)/documents/videos/${videoId}`;
  const payload = {
    fields: {
      views: { integerValue: views }
    }
  };

  const headers = {
    Authorization: `Bearer ${token.token}`,
    'Content-Type': 'application/json',
  };

  try {
    await axios.patch(url, payload, { headers });
    console.log(`📦 Firestore updated for video ${videoId}`);
  } catch (err) {
    console.error(`❌ Firestore update failed for ${videoId}:`, err.response?.data || err.message);
  }
}

async function logMintEvent(videoId, mintedAmount, txHash, title, skipped = false, viewsAdded = 0, totalViews = 0, gasUsed = null, gasPrice = null, subs = null) {
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const docId = skipped ? `skipped-${videoId}-${Date.now()}` : txHash;
  const url = `https://firestore.googleapis.com/v1/projects/diamond-zminter/databases/(default)/documents/mints?documentId=${docId}`;

  const payload = {
    fields: {
      videoId: { stringValue: videoId },
      title: { stringValue: title },
      minted: { integerValue: mintedAmount.toString() },
      wallet: { stringValue: wallet.address },
      timestamp: { timestampValue: new Date().toISOString() },
      txHash: { stringValue: docId },
      skipped: { booleanValue: skipped },
      viewsAdded: { integerValue: viewsAdded.toString() },
      viewCount: { integerValue: totalViews.toString() },
      ...(subs !== null && { subscriberCount: { integerValue: subs.toString() } }),
      ...(gasUsed && gasPrice && {
        gasUsed: { stringValue: gasUsed },
        gasPrice: { stringValue: gasPrice },
        gasCost: { stringValue: (BigInt(gasUsed) * BigInt(gasPrice)).toString() }
      })
    }
  };

  const headers = {
    Authorization: `Bearer ${token.token}`,
    'Content-Type': 'application/json',
  };

  try {
    await axios.post(url, payload, { headers });
    if (skipped) {
      console.log(`🪪 Skipped mint log written for video ${videoId} (${title})`);
    } else {
      console.log(`🧾 Mint log written for video ${videoId} (${title})`);
    }
  } catch (err) {
    console.error(`❌ Failed to log mint event for ${videoId}:`, err.response?.data || err.message);
  }
}

async function getFirestoreViews(videoId) {
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const url = `https://firestore.googleapis.com/v1/projects/diamond-zminter/databases/(default)/documents/videos/${videoId}`;
  const headers = {
    Authorization: `Bearer ${token.token}`,
  };

  try {
    const res = await axios.get(url, { headers });
    const views = parseInt(res.data.fields?.views?.integerValue || '0');
    return views;
  } catch (err) {
    return 0; // Default to 0 if no doc exists
  }
}

async function processEngagement() {
  console.log('🔍 Checking YouTube video stats...');
  const videos = await getLatestVideos(CHANNEL_ID, API_KEY);
  const subs = await getSubscriberCount(CHANNEL_ID, API_KEY);

  for (const video of videos) {
    const id = video.id.videoId;
    const stats = await getVideoStats(id, API_KEY);
    const newViews = parseInt(stats.viewCount || '0');
    const previousViews = await getFirestoreViews(id);
    const delta = newViews - previousViews;
    const title = video.snippet.title || "Untitled";

    if (delta > 0) {
      const tokensToMint = BigInt(Math.floor(delta / 20) * 5);
      try {
        const tx = await contract.mintFromOracle(
          wallet.address,
          tokensToMint,
          id,
          title,
          newViews,
          subs
        );
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed.toString();
        const gasPrice = tx.gasPrice?.toString() || '0';

        console.log(`✅ Minted ${tokensToMint} tokens to ${wallet.address}`);
        await updateFirestore(id, newViews);
        await logMintEvent(id, tokensToMint, tx.hash, title, false, delta, newViews, gasUsed, gasPrice, subs);
      } catch (err) {
        console.error(`❌ Minting failed:`, err);
      }
    } else {
      await logMintEvent(id, 0, '', title, true, delta, newViews, null, null, subs);
    }
  }
}

processEngagement().then(() => {
  console.log('✅ Oracle run complete');
  process.exit();
});
