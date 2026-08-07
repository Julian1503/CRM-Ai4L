export async function syncContactToEmailOctopus(
  apiKey: string,
  listId: string,
  email: string,
  firstName: string,
  lastName: string,
  status: 'SUBSCRIBED' | 'UNSUBSCRIBED'
): Promise<void> {
  const url = `https://emailoctopus.com/api/1.6/lists/${listId}/contacts`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      email_address: email,
      fields: {
        FirstName: firstName,
        LastName: lastName,
      },
      status: status,
    }),
  });

  if (!response.ok) {
    let errorMessage = `HTTP Error ${response.status}`;
    try {
      const errorJson = await response.json();
      if (errorJson.error && errorJson.error.message) {
        errorMessage = errorJson.error.message;
      }
    } catch {
      // ignore body parsing errors for non-JSON responses
    }
    throw new Error(`EmailOctopus API Error: ${errorMessage}`);
  }
}
