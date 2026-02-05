import lark_oapi as lark
from lark_oapi.api.bitable.v1 import *

APP_ID = "cli_a9f6ea75bdfadcda"
APP_SECRET = "5qi6SwZ82MtNCnGvVsUnFRwuPVAunm3n"
APP_TOKEN = "PcWlblUdFa4WJ9sNwFkcfuAnnof"
TABLE_ID = "tblbbwwt9iDwa7sT"

client = lark.Client.builder().app_id(APP_ID).app_secret(APP_SECRET).build()

req = CreateAppTableFieldRequest.builder() \
    .app_token(APP_TOKEN) \
    .table_id(TABLE_ID) \
    .request_body(AppTableField.builder().field_name("训练时长 (min)").type(2).build()) \
    .build()

resp = client.bitable.v1.app_table_field.create(req)
if resp.success(): print("Added Duration Field")
else: print(resp.msg)
