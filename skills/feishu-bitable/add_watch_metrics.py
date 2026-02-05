import lark_oapi as lark
from lark_oapi.api.bitable.v1 import *

APP_ID = "cli_a9f6ea75bdfadcda"
APP_SECRET = "5qi6SwZ82MtNCnGvVsUnFRwuPVAunm3n"
APP_TOKEN = "PcWlblUdFa4WJ9sNwFkcfuAnnof"
TABLE_ID = "tblbbwwt9iDwa7sT"

client = lark.Client.builder().app_id(APP_ID).app_secret(APP_SECRET).build()

fields = [
    {"name": "动态消耗 (kcal)", "type": 2},
    {"name": "总消耗 (kcal)", "type": 2},
    {"name": "平均心率 (bpm)", "type": 2},
    {"name": "总组数", "type": 2}
]

for f in fields:
    req = CreateAppTableFieldRequest.builder() \
        .app_token(APP_TOKEN) \
        .table_id(TABLE_ID) \
        .request_body(AppTableField.builder().field_name(f["name"]).type(f["type"]).build()) \
        .build()
    client.bitable.v1.app_table_field.create(req)
    print(f"Added {f['name']}")
