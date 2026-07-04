import os
import requests
import time
import psycopg2
from concurrent.futures import ThreadPoolExecutor
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from threading import Lock
from pypinyin import lazy_pinyin, Style

# ===================== 环境变量在Appwrite控制台配置 =====================
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER")
DB_PASS = os.getenv("DB_PASS")
TABLE_NAME = "vod"
MAX_THREAD = 3  # 海外环境调低并发，防止IP封禁
# ======================================================================
API_BASE_URL = "https://bfzyapi.com/api.php/provide/vod/"

KEEP_FIELDS = [
    "vod_id", "type_id", "type_name", "type_id_1",
    "vod_name", "vod_sub", "vod_en", "vod_letter",
    "vod_class", "vod_pic", "vod_actor", "vod_director",
    "vod_area", "vod_lang", "vod_year", "vod_douban_id",
    "vod_douban_score", "vod_content", "vod_remarks",
    "vod_score", "vod_play_url", "vod_status", "vod_time",
    "vod_name_letter"
]

progress_lock = Lock()
completed = 0
total_pages = 0

def get_chinese_first_letter(text: str) -> str:
    if not text:
        return ""
    result = []
    for char in text:
        if '\u4e00' <= char <= '\u9fff':
            pinyin_list = lazy_pinyin(char, style=Style.FIRST_LETTER)
            if pinyin_list:
                first_letter = pinyin_list[0].upper()
                if first_letter.isalpha():
                    result.append(first_letter)
        else:
            if char.isalpha():
                result.append(char.upper())
            elif char.isdigit():
                result.append(char)
        if len(result) >= 50:
            break
    return ''.join(result[:50])

def get_session():
    session = requests.Session()
    retry = Retry(total=5, backoff_factor=1, allowed_methods=["GET"])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session

def clean_field(val):
    if not val:
        return ""
    return val.split("$$$")[-1] if "$$$" in val else val

def clean_video_data(v):
    cleaned = {}
    for k in KEEP_FIELDS:
        if k == "vod_name_letter":
            vod_name = v.get("vod_name", "")
            cleaned[k] = get_chinese_first_letter(vod_name)
        else:
            value = v.get(k, "")
            if k == "vod_play_url":
                value = clean_field(value)
            cleaned[k] = value
    return cleaned

def get_new_db_conn():
    try:
        return psycopg2.connect(
            host=DB_HOST,
            port=DB_PORT,
            dbname=DB_NAME,
            user=DB_USER,
            password=DB_PASS,
            connect_timeout=10
        )
    except Exception as e:
        print(f"❌ 数据库连接失败: {str(e)}")
        return None

def save_single_page(videos):
    if not videos:
        return

    conn = get_new_db_conn()
    if not conn:
        return

    try:
        cur = conn.cursor()
        for v in videos:
            v = clean_video_data(v)
            cols = list(v.keys())
            vals = list(v.values())
            placeholders = ",".join(["%s"] * len(vals))
            updates = ",".join([f"{c}=%s" for c in cols])

            sql = f"""
            INSERT INTO {TABLE_NAME} ({','.join(cols)})
            VALUES ({placeholders})
            ON CONFLICT (vod_id) DO UPDATE SET {updates}
            """
            cur.execute(sql, vals + vals)

        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        print(f"⚠️ 当前页入库异常: {str(e)}")
        conn.rollback()
        conn.close()

def get_total_pages():
    try:
        resp = get_session().get(f"{API_BASE_URL}?pg=1&h=24", timeout=15)
        return int(resp.json().get("pagecount", 1))
    except Exception as e:
        print(f"获取总页数失败: {str(e)}")
        return 1

def get_ids_by_page(page):
    try:
        resp = get_session().get(f"{API_BASE_URL}?pg={page}", timeout=15)
        return [str(item["vod_id"]) for item in resp.json().get("list", []) if item.get("vod_id")]
    except Exception as e:
        print(f"第{page}页获取ID失败: {str(e)}")
        return []

def get_video_details(ids):
    if not ids:
        return []
    try:
        url = f"{API_BASE_URL}?ac=detail&ids={','.join(ids)}"
        return get_session().get(url, timeout=20).json().get("list", [])
    except Exception as e:
        print(f"批量获取详情失败: {str(e)}")
        return []

def task(page):
    global completed
    try:
        time.sleep(1.5)
        ids = get_ids_by_page(page)
        details = get_video_details(ids)
        save_single_page(details)
    finally:
        with progress_lock:
            completed += 1
            print(f"📊 进度：{completed}/{total_pages} | 第 {page} 页执行完成")

# Appwrite 函数入口
def main(context):
    global total_pages
    try:
        total_pages = get_total_pages()
        print(f"🚀 开始爬取，总页数：{total_pages}，并发线程：{MAX_THREAD}")

        with ThreadPoolExecutor(max_workers=MAX_THREAD) as executor:
            executor.map(task, range(1, total_pages + 1))

        return context.res.json({
            "code": 200,
            "msg": "全量爬取执行完成",
            "total_pages": total_pages
        })
    except Exception as e:
        err_msg = str(e)
        print(f"全局任务异常: {err_msg}")
        return context.res.json({
            "code": 500,
            "msg": "任务执行异常",
            "error": err_msg
        })