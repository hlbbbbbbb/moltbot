import argparse
import json
import sys
import lark_oapi as lark
from lark_oapi.api.bitable.v1 import *

# Credentials from TOOLS.md
APP_ID = "cli_a9f6ea75bdfadcda"
APP_SECRET = "5qi6SwZ82MtNCnGvVsUnFRwuPVAunm3n"

# Setup Client
client = lark.Client.builder() \
    .app_id(APP_ID) \
    .app_secret(APP_SECRET) \
    .log_level(lark.LogLevel.WARNING) \
    .build()

def list_records(app_token, table_id, page_token=None):
    request = ListAppTableRecordRequest.builder() \
        .app_token(app_token) \
        .table_id(table_id) \
        .page_size(20) \
        .build()
    
    if page_token:
        request.page_token = page_token

    response = client.bitable.v1.app_table_record.list(request)

    if not response.success():
        print(json.dumps({"error": response.msg, "code": response.code}))
        sys.exit(1)

    # Convert response to dict manually to ensure JSON serializable
    records = []
    if response.data and response.data.items:
        for item in response.data.items:
            records.append({
                "record_id": item.record_id,
                "fields": item.fields
            })
            
    print(json.dumps({"records": records, "total": response.data.total if response.data else 0}, ensure_ascii=False, indent=2))

def add_record(app_token, table_id, fields_json):
    try:
        fields = json.loads(fields_json)
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON for fields"}))
        sys.exit(1)

    request = CreateAppTableRecordRequest.builder() \
        .app_token(app_token) \
        .table_id(table_id) \
        .request_body(AppTableRecord.builder().fields(fields).build()) \
        .build()

    response = client.bitable.v1.app_table_record.create(request)

    if not response.success():
        print(json.dumps({"error": response.msg, "code": response.code}))
        sys.exit(1)

    print(json.dumps({
        "status": "created",
        "record_id": response.data.record.record_id,
        "fields": response.data.record.fields
    }, ensure_ascii=False, indent=2))

def update_record(app_token, table_id, record_id, fields_json):
    try:
        fields = json.loads(fields_json)
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON for fields"}))
        sys.exit(1)

    request = UpdateAppTableRecordRequest.builder() \
        .app_token(app_token) \
        .table_id(table_id) \
        .record_id(record_id) \
        .request_body(AppTableRecord.builder().fields(fields).build()) \
        .build()

    response = client.bitable.v1.app_table_record.update(request)

    if not response.success():
        print(json.dumps({"error": response.msg, "code": response.code}))
        sys.exit(1)

    print(json.dumps({
        "status": "updated",
        "record_id": response.data.record.record_id,
        "fields": response.data.record.fields
    }, ensure_ascii=False, indent=2))

def main():
    parser = argparse.ArgumentParser(description="Manage Feishu Bitable")
    parser.add_argument("action", choices=["list", "add", "update"], help="Action to perform")
    parser.add_argument("--app-token", required=True, help="Bitable App Token")
    parser.add_argument("--table-id", required=True, help="Bitable Table ID")
    parser.add_argument("--record-id", help="Record ID for update action")
    parser.add_argument("--fields", help="JSON string of fields for add/update action")
    parser.add_argument("--page-token", help="Page token for list action")

    args = parser.parse_args()

    if args.action == "list":
        list_records(args.app_token, args.table_id, args.page_token)
    elif args.action == "add":
        if not args.fields:
            print(json.dumps({"error": "--fields is required for add action"}))
            sys.exit(1)
        add_record(args.app_token, args.table_id, args.fields)
    elif args.action == "update":
        if not args.fields or not args.record_id:
            print(json.dumps({"error": "--fields and --record-id are required for update action"}))
            sys.exit(1)
        update_record(args.app_token, args.table_id, args.record_id, args.fields)

if __name__ == "__main__":
    main()
