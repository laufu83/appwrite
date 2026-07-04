import axios, { AxiosInstance } from 'axios';
import { Pool, PoolClient } from 'pg';
import pinyin from 'pinyin';
import dotenv from 'dotenv';
dotenv.config();
// ==================== 类型定义 ====================
type VideoItem = Record<string, string | number | undefined>;

type AppwriteContext = {
  req: Request & { json: () => Promise<unknown> };
  res: {
    json: (obj: unknown) => { send: () => void };
    text: (text: string) => { send: () => void };
  };
  log: (message: string) => void;
  error: (message: string) => void;
};

const KEEP_FIELDS = [
  "vod_id", "type_id", "type_name", "type_id_1",
  "vod_name", "vod_sub", "vod_en", "vod_letter",
  "vod_class", "vod_pic", "vod_actor", "vod_director",
  "vod_area", "vod_lang", "vod_year", "vod_douban_id",
  "vod_douban_score", "vod_content", "vod_remarks",
  "vod_score", "vod_play_url", "vod_status", "vod_time",
  "vod_name_letter"
] as const;

// ==================== 环境变量 ====================
const DB_HOST = process.env.DB_HOST;
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const TABLE_NAME = process.env.TABLE_NAME || 'vod';
const MAX_THREAD = parseInt(process.env.MAX_THREAD || '3');
const API_BASE_URL = 'https://bfzyapi.com/api.php/provide/vod/';

// ==================== 检查环境变量 ====================
if (!DB_HOST || !DB_USER || !DB_PASS) {
  console.error('❌ 请检查环境变量，缺少必要的数据库配置');
  console.error('需要设置: DB_HOST, DB_USER, DB_PASS');
  process.exit(1);
}

// ==================== PG 连接池 ====================
const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASS,
  connectionTimeoutMillis: 10000,
  max: 5,
});

// ==================== 工具函数 ====================
function getFirstLetter(text: string): string {
  if (!text) return '';
  const result: string[] = [];
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      const py = pinyin(char, { style: pinyin.STYLE_FIRST_LETTER });
      if (py.length) {
        const letter = py[0][0].toUpperCase();
        if (/[A-Z]/.test(letter)) result.push(letter);
      }
    } else if (/[a-zA-Z]/.test(char)) {
      result.push(char.toUpperCase());
    } else if (/\d/.test(char)) {
      result.push(char);
    }
    if (result.length >= 50) break;
  }
  return result.join('').slice(0, 50);
}

function cleanField(val?: string): string {
  if (!val) return '';
  return val.includes('$$$') ? val.split('$$$').pop()! : val;
}

function cleanVideo(v: VideoItem): Record<string, string | number> {
  const item: Record<string, string | number> = {};
  for (const key of KEEP_FIELDS) {
    if (key === 'vod_name_letter') {
      item[key] = getFirstLetter(String(v.vod_name ?? ''));
    } else {
      let val = v[key] ?? '';
      if (key === 'vod_play_url') val = cleanField(String(val));
      item[key] = val;
    }
  }
  return item;
}

// ==================== 数据库操作 ====================
async function savePage(videoList: VideoItem[]): Promise<void> {
  // ✅ 已删除 if(true) return;
  if (!videoList.length) return;
  const client: PoolClient = await pool.connect();
  try {
    for (const raw of videoList) {
      const data = cleanVideo(raw);
      const cols = Object.keys(data);
      const values = Object.values(data);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      const updates = cols.map(c => `${c}=EXCLUDED.${c}`).join(',');

      const sql = `
        INSERT INTO ${TABLE_NAME} (${cols.join(',')})
        VALUES (${placeholders})
        ON CONFLICT (vod_id) DO UPDATE SET ${updates}
      `;
      await client.query(sql, values);
    }
    console.log(`✅ 当前页 ${videoList.length} 条入库完成`);
  } catch (e) {
    console.error('❌ 页面入库失败', (e as Error).message);
  } finally {
    client.release();
  }
}

// ==================== HTTP 请求 ====================
const axiosInstance: AxiosInstance = axios.create({ timeout: 20000 });

axiosInstance.interceptors.response.use(
  res => res,
  async (err) => {
    const config = err.config;
    config._retry = config._retry ?? 0;
    if (config._retry < 5) {
      config._retry++;
      await new Promise(r => setTimeout(r, 1000 * config._retry));
      return axiosInstance(config);
    }
    return Promise.reject(err);
  }
);

interface ApiResponse {
  pagecount?: string | number;
  list?: Array<{ vod_id?: number | string }>;
}

async function getTotalPage(): Promise<number> {
  try {
    const res = await axiosInstance.get<ApiResponse>(`${API_BASE_URL}?pg=1&h=24`);
    return Number(res.data.pagecount) || 1;
  } catch (e) {
    console.error('获取总页数失败', (e as Error).message);
    return 1;
  }
}

async function getPageIds(page: number): Promise<string[]> {
  try {
    const res = await axiosInstance.get<ApiResponse>(`${API_BASE_URL}?pg=${page}`);
    return (res.data.list || [])
      .map((item) => String(item.vod_id))
      .filter(Boolean);
  } catch (e) {
    console.error(`第${page}页ID拉取失败`, (e as Error).message);
    return [];
  }
}

async function getDetailByIds(ids: string[]): Promise<VideoItem[]> {
  if (!ids.length) return [];
  try {
    const res = await axiosInstance.get<{ list?: VideoItem[] }>(
      `${API_BASE_URL}?ac=detail&ids=${ids.join(',')}`
    );
    return res.data.list || [];
  } catch (e) {
    console.error('批量详情拉取失败', (e as Error).message);
    return [];
  }
}

async function pageTask(page: number): Promise<void> {
  await new Promise(r => setTimeout(r, 1500));
  const ids = await getPageIds(page);
  if (!ids.length) return;
  const list = await getDetailByIds(ids);
  await savePage(list);
  console.log(`📄 第 ${page} 页处理完毕`);
}

async function runCrawl(): Promise<{ totalPages: number }> {
  const total = await getTotalPage();
  console.log(`🚀 开始爬虫，总页数：${total}，并发：${MAX_THREAD}`);

  const pages = Array.from({ length: total }, (_, i) => i + 1);
  let index = 0;

  const workers = Array(MAX_THREAD)
    .fill(0)
    .map(async () => {
      while (index < pages.length) {
        const current = pages[index++];
        await pageTask(current);
      }
    });

  await Promise.all(workers);
  return { totalPages: total };
}

// ==================== Appwrite 函数入口 ====================
export default async function main(context: AppwriteContext) {
  const { res, log, error } = context;

  try {
    log('🚀 爬虫任务开始执行...');
    const result = await runCrawl();
    log(`✅ 爬虫任务完成，共处理 ${result.totalPages} 页`);

    return res.json({
      code: 200,
      msg: '爬虫任务执行完成',
      data: result,
    });
  } catch (err) {
    error('❌ 任务异常');
    return res.json({
      code: 500,
      msg: '任务异常',
      error: (err as Error).message,
    });
  }
}

// ==================== 本地调试入口 ====================
// 如果在本地运行（非 Appwrite 环境），执行 main

  // console.log('🚀 本地调试模式启动...');
  // main({
  //   req: {} as Request,
  //   res: {
  //     json: (obj: unknown) => {
  //       console.log('📊 返回结果:', JSON.stringify(obj, null, 2));
  //       return { send: () => {} };
  //     },
  //     text: (text: string) => {
  //       console.log('📝 返回文本:', text);
  //       return { send: () => {} };
  //     }
  //   },
  //   log: console.log,
  //   error: console.error
  // }).catch(console.error);
