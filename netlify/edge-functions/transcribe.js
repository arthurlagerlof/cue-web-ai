const ENDPOINT = 'https://free-whisper-transcription.lagerlof-arthur.workers.dev/';

export default async function transcribe(request) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
    return new Response('Expected multipart audio', { status: 400 });
  }
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: request.body,
      duplex: 'half',
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Cloud transcription relay failed:', error);
    return new Response('Cloud transcription unavailable', { status: 502 });
  }
}
