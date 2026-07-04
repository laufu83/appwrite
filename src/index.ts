import axios from 'axios';
import { Pool, PoolClient } from 'pg';
import pinyin from 'pinyin';

// 环境变量
const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT || '5432';
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const TABLE_NAME = 'vod';
const MAX_THREAD = 3;
const API_BASE_URL = 'https://bfzyapi.com/api.php/provide/vod/';

type VideoItem = Record<string, string | number | undefined>;

const KEEP_FIELDS = [
  "vod_id", "type_id", "type_name", "type_id_1",
  "vod_name", "vod_sub", "vod_en", "vod_letter",
  "vod_class", "vod_pic", "vod_actor", "vod_director",
  "vod_area", "vod_lang", "vod_year", "vod_douban_id",
  "vod_douban_score", "vod_content", "vod_remarks",
  "vod_score", "vod_play_url", "vod_status", "vod_time",
  "vod_name_letter"
] as const;

// PG连接池
const pool = new Pool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASS,
  connectionTimeoutMillis: 10000
});

/** 获取中文名拼音首字母大写，最多50字符 */
function getFirstLetter(text: string): string {
  if (!text) return '';
  const res: string[] = [];
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      const py = pinyin(char, { style: pinyin.STYLE_FIRST_LETTER });
      if (py.length) {
        const letter = py[0][0].toUpperCase();
        if (/[A-Z]/.test(letter)) res.push(letter);
      }
    } else if (/[a-zA-Z]/.test(char)) {
      res.push(char.toUpperCase());
    } else if (/\d/.test(char)) {
      res.push(char);
    }
    if (res.length >= 50) break;
  }
  return res.join('').slice(0, 50);
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

async function savePage(videoList: VideoItem[]) {
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

// axios 重试实例
const axiosInstance = axios.create({ timeout: 20000 });
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

async function getTotalPage(): Promise<number> {
  try {
    const res = await axiosInstance.get(`${API_BASE_URL}?pg=1&h=24`);
    return Number(res.data.pagecount) || 1;
  } catch (e) {
    console.error('获取总页数失败', (e as Error).message);
    return 1;
  }
}

async function getPageIds(page: number): Promise<string[]> {
  try {
    const res = await axiosInstance.get(`${API_BASE_URL}?pg=${page}`);
    return (res.data.list || [])
      .map((item: { vod_id?: number }) => String(item.vod_id))
      .filter(Boolean);
  } catch (e) {
    console.error(`第${page}页ID拉取失败`, (e as Error).message);
    return [];
  }
}

async function getDetailByIds(ids: string[]): Promise<VideoItem[]> {
  if (!ids.length) return [];
  try {
    const res = await axiosInstance.get(`${API_BASE_URL}?ac=detail&ids=${ids.join(',')}`);
    return res.data.list || [];
  } catch (e) {
    console.error('批量详情拉取失败', (e as Error).message);
    return [];
  }
}

async function pageTask(page: number) {
  await new Promise(r => setTimeout(r, 1500));
  const ids = await getPageIds(page);
  if (!ids.length) return;
  const list = await getDetailByIds(ids);
  await savePage(list);
  console.log(`📄 第 ${page} 页处理完毕`);
}

async function runCrawl() {
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

// Appwrite 函数入口
type AppwriteContext = {
  req: unknown;
  res: {
    json: (obj: unknown) => unknown;
  };
};

module.exports = async ({ res }: AppwriteContext) => {
  try {
    const result = await runCrawl();
    return res.json({
      code: 200,
      msg: '爬虫任务执行完成',
      data: result
    });
  } catch (err) {
    return res.json({
      code: 500,
      msg: '任务异常',
      error: (err as Error).message
    });
  }
};