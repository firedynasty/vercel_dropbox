#!/usr/bin/env python3
"""
Google Calendar API - Upcoming Events Script
This script fetches and displays upcoming events from your Google Calendar.
"""

import os
import datetime
import json
from googleapiclient.discovery import build
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.errors import HttpError

# If modifying these scopes, delete the token.json file
# Use both Gmail and Calendar scopes to work with existing token.json
SCOPES = ['https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/calendar.readonly',
          'https://www.googleapis.com/auth/calendar']

def get_calendar_service():
    """
    Authenticate and create a Google Calendar API service
    """
    creds = None
    # The file token.json stores the user's access and refresh tokens
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    
    # If there are no valid credentials available, let the user log in
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                'credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        
        # Save the credentials for the next run
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    return build('calendar', 'v3', credentials=creds)

def format_event_time(event):
    """Format the event time based on whether it's an all-day event or not"""
    start = event['start'].get('dateTime', event['start'].get('date'))
    end = event['end'].get('dateTime', event['end'].get('date'))
    
    # Check if all-day event (date only, no time)
    if 'T' not in start:
        # Parse as date
        start_obj = datetime.datetime.strptime(start, '%Y-%m-%d').date()
        end_obj = datetime.datetime.strptime(end, '%Y-%m-%d').date()

        # Calculate duration in days
        duration = (end_obj - start_obj).days
        
        if duration <= 1:
            return f"All day {start_obj.strftime('%a, %b %d, %Y')}"
        else:
            return f"All day {start_obj.strftime('%a, %b %d')} - {end_obj.strftime('%a, %b %d, %Y')}"
    else:
        # Parse as datetime
        start_obj = datetime.datetime.fromisoformat(start.replace('Z', '+00:00'))
        end_obj = datetime.datetime.fromisoformat(end.replace('Z', '+00:00'))
        
        # Format based on local time
        start_local = start_obj.astimezone()
        end_local = end_obj.astimezone()
        
        # If same day
        if start_local.date() == end_local.date():
            return f"{start_local.strftime('%a, %b %d, %Y, %I:%M %p')} - {end_local.strftime('%I:%M %p')}"
        else:
            return f"{start_local.strftime('%a, %b %d, %I:%M %p')} - {end_local.strftime('%a, %b %d, %I:%M %p')}"

def get_upcoming_events(num_events=10):
    """
    Get a list of upcoming events from your calendar
    """
    service = get_calendar_service()
    
    # Get today's date at midnight
    now = datetime.datetime.utcnow().isoformat() + 'Z'  # 'Z' indicates UTC time
    
    print(f"Fetching your upcoming {num_events} events...")
    
    # Call the Calendar API
    events_result = service.events().list(
        calendarId='primary',  # Use 'primary' for the user's primary calendar
        timeMin=now,
        maxResults=num_events,
        singleEvents=True,
        orderBy='startTime'
    ).execute()
    
    events = events_result.get('items', [])
    
    if not events:
        print('No upcoming events found.')
        return
    
    # Print events
    print("\nYOUR UPCOMING EVENTS:")
    print("=====================")
    
    for i, event in enumerate(events, 1):
        event_time = format_event_time(event)
        location = event.get('location', 'No location specified')
        
        print(f"{i}. {event['summary']}")
        print(f"   {event_time}")
        
        # Only show location if it exists
        if 'location' in event:
            print(f"   📍 {location}")
            
        # Show description if it exists (first 50 chars)
        if 'description' in event and event['description'].strip():
            desc = event['description'].strip()
            if len(desc) > 50:
                desc = desc[:47] + "..."
            print(f"   📝 {desc}")
            
        print()  # Empty line between events

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Show upcoming Google Calendar events')
    parser.add_argument('--events', type=int, default=10, 
                        help='Number of events to display (default: 10)')
    
    args = parser.parse_args()
    get_upcoming_events(args.events)