import datetime
import re
import os.path
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# Define the scopes for Gmail API
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

def get_gmail_service():
    """
    Authenticate and get the Gmail API service.
    Requires a credentials.json file from Google Cloud Console.
    """
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                'credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)

        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    return build('gmail', 'v1', credentials=creds)

def get_todays_emails(service):
    """
    Get and display all emails received today.
    """
    today = datetime.datetime.now().strftime('%Y/%m/%d')
    query = f'after:{today}'

    try:
        results = service.users().messages().list(userId='me', q=query).execute()
        messages = results.get('messages', [])

        if not messages:
            print(f"No messages found for {today}.")
            return

        print(f"Found {len(messages)} messages from today ({today}):")
        print("=" * 60)

        for i, message in enumerate(messages, 1):
            msg = service.users().messages().get(userId='me', id=message['id']).execute()
            headers = msg['payload']['headers']

            sender = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown')
            subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
            date = next((h['value'] for h in headers if h['name'] == 'Date'), 'Unknown')

            # Extract domain from sender
            domain_match = re.search(r'@([^>]+)', sender)
            domain = domain_match.group(1) if domain_match else 'Unknown'

            print(f"\n{i}. {subject}")
            print(f"   From: {sender}")
            print(f"   Domain: {domain}")
            print(f"   Date: {date}")

    except Exception as e:
        print(f"Error fetching emails: {e}")

def main():
    service = get_gmail_service()
    get_todays_emails(service)

if __name__ == "__main__":
    main()
