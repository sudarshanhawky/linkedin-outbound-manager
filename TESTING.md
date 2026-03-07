# Testing the LinkedIn Outbound Manager

## Quick test with the sample file

A sample file is included so you can test import, status mapping, and filters without building your own sheet.

### 1. Use the sample CSV

- **File:** `sample-import-contacts.csv` (in the project root)
- In the app, click **Import CSV or Excel** and choose this file.
- Accept the single “sheet” and click **Import**.

### 2. What the sample data covers

| Row / case | What to check |
|------------|----------------|
| **John Doe** | Status **Contacted** → should show as **Message Sent**. |
| **Jane Smith** | Status **In Campaign** → **Request Sent**. Campaign **IND_LIST 5,6,7** → in filters you should see **IND_LIST 5**, **IND_LIST 6**, **IND_LIST 7** as separate options. |
| **Same Person** (2 rows) | Same LinkedIn URL twice: one row **Request Sent**, one **Replied** + tag “Interested”. After import you should see **one** contact with status **Converted** (higher rank wins) and campaigns **Campaign A, Campaign B** and senders **Sender One, Sender Two**. |
| **Sarah Lee** | **Replied** + tag “nurturing” → **Replied**. |
| **Mike Brown** | **Replied** + “Not interested” → **Not Interested**. |
| **Anna Wu** | **Replied** + “Non ICP” → **Wrong Person**. |
| **Tom Davis** | **Not Contacted** → **Not Contacted**. |
| **Lisa Park** | **failed** → **Not Contacted**. |
| **Duplicate Row** | Status **duplicate** → this row should **not** be imported (SKIP). |
| **Emma Wilson** | **Replied** + “Scheduled” → **Converted**. |
| **Chris Lee** | **Replied** + “Already in pipeline” → **Converted**. |
| **Alex Kim** | **not accepted** → **Request Sent**. |

### 3. Things to test in the UI

- **Import:** Import the sample CSV/Excel and confirm row count and statuses match the table above.
- **Filters:** Use Status, Campaign, and Sender multi-select; confirm counts and that “IND_LIST 5”, “IND_LIST 6”, “IND_LIST 7” appear as separate campaign filters.
- **Sort:** Change sort field and A–Z / Z–A and confirm the table updates.
- **Bulk select:** Select a few rows, then “Select all X contacts (filtered)”, then **Delete** (with confirmation).
- **Export:** Select some contacts (or leave none selected to export filtered list), use **Export Contacts** → Excel and CSV; open the files and confirm columns and data.
- **Pagination:** Change “Rows per page” (10, 20, 50, 100) and use Previous/Next and page numbers.
- **Persistence:** Reload the page and confirm contacts (and filters, if you store them) are still there.
- **Info icon:** Click the (i) next to “Contacts” and confirm the status rules modal opens.
- **Profile & sign out:** Change profile name (click name), then **Sign out** and confirm the page reloads and name resets.

### 4. Creating your own Excel for testing

Use the same column headers (spelling and order can match the sample):

- **Name** – Full name  
- **Company** – Company name  
- **Job Title** – Job title  
- **LinkedIn** – Full LinkedIn profile URL  
- **Status** – One of: `Contacted`, `In Campaign`, `not accepted`, `Not Contacted`, `failed`, `Replied`, `duplicate`  
- **Tags** – For “Replied” only: e.g. blank, `nurturing`, `Interested`, `Not interested`, `Non ICP`, `Wrong`, `Scheduled`, `Already in pipeline`  
- **CampaignName** – Campaign name (use `IND_LIST 5,6,7` in one cell if you want to test filter expansion)  
- **Sender Name** – Sender name  

Save as **.csv** (Excel can open it) or **.xlsx**. Then use **Import CSV or Excel** in the app and run through the same checks as above.
