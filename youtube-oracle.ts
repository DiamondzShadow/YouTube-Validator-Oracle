// zsLabTuB3 Oracle (zsT3): YouTube engagement mint oracle with on-chain emit, subscriber/view logging, and treasury-aware tokenomics

import dotenv from 'dotenv';
dotenv.config();

import { JsonRpcProvider } from 'ethers';
import { Wallet, Contract } from 'ethers';
import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';
import contractABI from '../zTuB3-Diamondz-Contract/upgradeable-token/abi.json';

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
const CHANNEL_ID = process.env.CHANNEL_ID!;
const API_KEY = process.env.API_KEY!;

const DAILY_QUOTA = 10000;
const BUFFER = 500; // Safety buffer to prevent quota exhaustion
let quotaUsed = 0;

const provider = new JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);
const contract = new Contract(CONTRACT_ADDRESS, contractABI, wallet);

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/datastore'],
});

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getLatestVideos(channelId: string, apiKey: string) {
  quotaUsed += 100; // search.list costs 100 units
  const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
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

async function getVideoStats(videoId: string, apiKey: string) {
  quotaUsed += 1; // videos.list costs 1 unit
  const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
    params: {
      part: 'statistics',
      id: videoId,
      key: apiKey,
    },
  });
  return res.data.items[0].statistics;
}

async function getSubscriberCount(channelId: string, apiKey: string) {
  quotaUsed += 1; // channels.list costs 1 unit
  const res = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
    params: {
      part: 'statistics',
      id: channelId,
      key: apiKey,
    },
  });
  return parseInt(res.data.items[0]?.statistics?.subscriberCount || '0');
}

async function getFirestoreDoc(videoId: string) {
  try {
    const res = await axios.get(`https://firestore.googleapis.com/v1/projects/diamond-zminter/databases/(default)/documents/videos/${videoId}`);
    return res.data;
  } catch (err) {
    return null;
  }
}

async function updateFirestore(videoId: string, views: number) {
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const url = `https://firestore.googleapis.com/v1/projects/diamond-zminter/databases/(default)/documents/videos/${videoId}`;
  const payload = {
    fields: {
      views: { integerValue: views },
    },
  };

  const headers = {
    Authorization: `Bearer ${token.token}`,
    'Content-Type': 'application/json',
  };

  return axios.patch(url, payload, { headers });
}

async function maybeMintSubs(currentSubs: number) {
  const doc = await getFirestoreDoc('subs');
  const last = doc?.fields?.count?.integerValue ? parseInt(doc.fields.count.integerValue, 10) : 0;
  const delta = currentSubs - last;

  if (delta >= 10) {
    const reward = Math.floor(delta / 10) * 100n;
    const tx = await contract.mint(wallet.address, reward);
    await tx.wait();
    console.log(`🎉 Minted ${reward} tokens for ${delta} new subs.`);

    await updateFirestore('subs', currentSubs);
  }
}

async function main() {
  while (true) {
    console.log("🚀 Starting zTuB3 Oracle cycle");

    if (quotaUsed >= DAILY_QUOTA - BUFFER) {
      console.log("🚨 Quota buffer hit. Sleeping 4 hours to reset...");
      quotaUsed = 0;
      await sleep(4 * 60 * 60 * 1000);
      continue;
    }

    const latestVideos = await getLatestVideos(CHANNEL_ID, API_KEY);

    for (const video of latestVideos) {
      const videoId = video.id.videoId;
      const title = video.snippet.title;

      if (quotaUsed >= DAILY_QUOTA - BUFFER) break;
      await sleep(90 * 1000); // 90s per video scan

      try {
        const stats = await getVideoStats(videoId, API_KEY);
        const views = parseInt(stats.viewCount || '0', 10);

        const firestoreDoc = await getFirestoreDoc(videoId);
        const lastViews = firestoreDoc?.fields?.views?.integerValue ? parseInt(firestoreDoc.fields.views.integerValue, 10) : 0;
        const delta = views - lastViews;

        if (delta > 0) {
          const mintAmount = BigInt(Math.floor(delta / 20) * 5);
          if (mintAmount > 0n) {
            const tx = await contract.mint(wallet.address, mintAmount);
            await tx.wait();
            console.log(`✅ Minted ${mintAmount} for ${delta} views on ${title}`);
          }

          await updateFirestore(videoId, views);
        } else {
          console.log(`🕵️ No new views for ${title}`);
        }
      } catch (err) {
        console.error(`❌ Error processing ${videoId}`, err);
      }
    }

    const subs = await getSubscriberCount(CHANNEL_ID, API_KEY);
    await maybeMintSubs(subs);

    console.log("⏳ Sleeping for 45 minutes before next cycle...");
    await sleep(45 * 60 * 1000);
  }
}

main();
