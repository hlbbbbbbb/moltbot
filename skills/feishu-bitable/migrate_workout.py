import lark_oapi as lark
from lark_oapi.api.bitable.v1 import *

APP_ID = "cli_a9f6ea75bdfadcda"
APP_SECRET = "5qi6SwZ82MtNCnGvVsUnFRwuPVAunm3n"
APP_TOKEN = "PcWlblUdFa4WJ9sNwFkcfuAnnof"
TABLE_ID = "tblbbwwt9iDwa7sT" # 训练记录表

client = lark.Client.builder() \
    .app_id(APP_ID) \
    .app_secret(APP_SECRET) \
    .build()

fields_to_add = [
    {"field_name": "最大重量 (kg)", "type": 2},
    {"field_name": "训练容量 (kg)", "type": 2},
    {"field_name": "RPE (1-10)", "type": 2}
]

for field in fields_to_add:
    req = CreateAppTableFieldRequest.builder() \
        .app_token(APP_TOKEN) \
        .table_id(TABLE_ID) \
        .request_body(AppTableField.builder().field_name(field["field_name"]).type(field["type"]).build()) \
        .build()
    
    resp = client.bitable.v1.app_table_field.create(req)
    
    if resp.success():
        print(f"Created field: {field['field_name']}")
    else:
        print(f"Failed/Exists: {field['field_name']} - {resp.msg}")
