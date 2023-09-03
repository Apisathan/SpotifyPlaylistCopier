import fs from "fs";
import fetch from "node-fetch";
import cron from "node-cron";
import express from "express";
import open from "open";
import {getISOWeek} from 'date-fns'
import {config} from "dotenv";

config();

const REDIRECT_URI = 'http://localhost:3000/callback'; // You can set this to 'http://localhost:3000/callback' for testing purposes

const CLIENT_ID                     = process.env.CLIENT_ID;
const CLIENT_SECRET                 = process.env.CLIENT_SECRET;
const SOURCE_PLAYLIST_ID            = process.env.SOURCE_PLAYLIST_ID; // Replace with the source playlist ID
const TARGET_PLAYLIST_NAME_TEMPLATE = process.env.TARGET_PLAYLIST_NAME_TEMPLATE; //{0} will be replaced with the week number
const USER_ID                       = process.env.USER_ID;

let accessToken  = '';
let refreshToken = '';

const app = express();

const authOptions = {
	method : 'POST',
	headers: {
		'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
		'Content-Type' : 'application/x-www-form-urlencoded',
	},
};

function checkRefreshTokenFile() {
	if (fs.existsSync('refresh_token.txt')) {
		refreshToken = fs.readFileSync('refresh_token.txt', 'utf8').trim();
	}
}

async function checkRefreshTokenValidity() {
	if (refreshToken) {
		const response = await fetch('https://accounts.spotify.com/api/token', {
			method : 'POST',
			headers: {
				'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
				'Content-Type' : 'application/x-www-form-urlencoded',
			},
			body   : 'grant_type=refresh_token&refresh_token=' + refreshToken,
		});

		const data = await response.json();
		if (!data.error) {
			accessToken = data.access_token;
			return true;
		} else {
			console.error('Invalid or expired refresh token. Please reauthorize.');
			return false;
		}
	}

	return false;
}

async function authorize() {
	checkRefreshTokenFile();
	if (!(await checkRefreshTokenValidity())) {
		// If the refresh token is invalid or expired, open the authorization window
		const server = app.listen(3000, () => {
			console.log('Server listening on port 3000...');
			open('https://accounts.spotify.com/authorize' +
				'?response_type=code' +
				'&client_id=' + CLIENT_ID +
				'&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
				'&scope=playlist-modify-private%20playlist-modify-public%20playlist-read-private');
		});

		app.get('/callback', async (req, res) => {
			const code       = req.query.code;
			authOptions.body = 'grant_type=authorization_code&redirect_uri=' + encodeURIComponent(REDIRECT_URI) + '&code=' + code;

			const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
			const data     = await response.json();
			accessToken    = data.access_token;
			refreshToken   = data.refresh_token;

			// Save the refresh token to a file
			fs.writeFileSync('refresh_token.txt', refreshToken);

			res.send('Authorization successful. You can close this page now.');
			server.close();
		});
	}
}

async function getAccessToken() {
	// Check if a refresh token exists in the file and validate it
	checkRefreshTokenFile();
	if (await checkRefreshTokenValidity()) {
		// Save the updated access token (in case the previous one expired)
		fs.writeFileSync('refresh_token.txt', refreshToken);
		return accessToken;
	} else {
		throw new Error('Authorization failed. Please reauthorize.');
	}
}

async function copyPlaylistTracks() {
	const accessToken = await getAccessToken();

	const weekNumber         = getISOWeek(new Date());
	const targetPlaylistName = TARGET_PLAYLIST_NAME_TEMPLATE.replace('{0}', weekNumber);

	const createPlaylistOptions = {
		method : 'POST',
		headers: {
			'Authorization': 'Bearer ' + accessToken,
			'Content-Type' : 'application/json',
		},
		body   : JSON.stringify({
			name  : targetPlaylistName,
			public: false,
		}),
	};

	const sourcePlaylistResponse = await fetch(`https://api.spotify.com/v1/playlists/${SOURCE_PLAYLIST_ID}/tracks?fields=items(track(uri))`, {
		method : 'GET',
		headers: {
			'Authorization': 'Bearer ' + accessToken,
		},
	});
	const sourcePlaylistData     = await sourcePlaylistResponse.json();
	const trackUris              = sourcePlaylistData.items.map(item => item.track.uri);

	if (trackUris.length) {
		const createPlaylistResponse = await fetch(`https://api.spotify.com/v1/users/${USER_ID}/playlists`, createPlaylistOptions);
		const newPlaylistData        = await createPlaylistResponse.json();
		const newPlaylistId          = newPlaylistData.id;

		const addTracksOptions = {
			method : 'POST',
			headers: {
				'Authorization': 'Bearer ' + accessToken,
				'Content-Type' : 'application/json',
			},
			body   : JSON.stringify({
				uris: trackUris,
			}),
		};

		const addTracksResponse = await fetch(`https://api.spotify.com/v1/playlists/${newPlaylistId}/tracks`, addTracksOptions);
		if (addTracksResponse.status === 201) {
			console.log(`Successfully copied tracks to the new playlist: ${targetPlaylistName}`);
		} else {
			console.error('Failed to copy tracks to the new playlist.');
		}
	} else {
		console.log('No tracks in the source playlist.');
	}
}

// Schedule the script to run every Monday at 4:00 // Server is in UTC
cron.schedule('0 4 * * 1', () => {
	copyPlaylistTracks();
});

// Call the authorize function to handle authorization at the start
authorize();
