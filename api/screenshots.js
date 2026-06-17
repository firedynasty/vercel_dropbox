export default async function handler(req, res) {
  const url = req.query.url || process.env.DROPBOX_SCREENSHOTS_URL;
  if (!url) {
    return res.status(400).json({ error: 'Missing ?url= parameter or DROPBOX_SCREENSHOTS_URL env var' });
  }

  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Upstream error ' + response.status });
    }
    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
