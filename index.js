import axios from 'axios';
import cfonts from 'cfonts';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline';
import { Wallet } from 'ethers';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import fs from 'fs/promises';

function delay(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function centerText(text, color = 'greenBright') {
  const terminalWidth = process.stdout.columns || 80;
  const textLength = text.length;
  const padding = Math.max(0, Math.floor((terminalWidth - textLength) / 2));
  return ' '.repeat(padding) + chalk[color](text);
}

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/102.0'
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function getHeaders(token = null) {
  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Origin': 'https://monadscore.xyz',
    'Referer': 'https://monadscore.xyz/'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function getAxiosConfig(proxy, token = null) {
  const config = {
    headers: getHeaders(token),
    timeout: 60000
  };
  if (proxy) {
    config.httpsAgent = newAgent(proxy);
  }
  return config;
}

function newAgent(proxy) {
  if (proxy.startsWith('http://') || proxy.startsWith('https://')) {
    return new HttpsProxyAgent(proxy);
  } else if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
    return new SocksProxyAgent(proxy);
  } else {
    console.log(chalk.red(`不支持的代理类型: ${proxy}`));
    return null;
  }
}

async function requestWithRetry(method, url, payload = null, config = null, retries = 3, backoff = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      let response;
      if (method === 'get') {
        response = await axios.get(url, config);
      } else if (method === 'post') {
        response = await axios.post(url, payload, config);
      } else if (method === 'put') {
        response = await axios.put(url, payload, config);
      } else {
        throw new Error(`不支持的请求方法: ${method}`);
      }
      return response;
    } catch (error) {
      if (i < retries - 1) {
        await delay(backoff / 1000);
        backoff *= 1.5;
        continue;
      } else {
        throw error;
      }
    }
  }
}

async function readAccounts() {
  try {
    const data = await fs.readFile('accounts.json', 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(chalk.red(`读取 accounts.json 出错: ${error.message}`));
    return [];
  }
}

async function readProxies() {
  try {
    const data = await fs.readFile('proxy.txt', 'utf-8');
    return data
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch (error) {
    console.error(chalk.red(`读取 proxy.txt 出错: ${error.message}`));
    return [];
  }
}

async function getPublicIP(proxy) {
  try {
    const response = await requestWithRetry('get', 'https://api.ipify.org?format=json', null, getAxiosConfig(proxy));
    if (response && response.data && response.data.ip) {
      return response.data.ip;
    } else {
      return '未找到 IP';
    }
  } catch (error) {
    return '获取 IP 出错';
  }
}

async function getInitialToken(walletAddress, proxy) {
  const url = 'https://mscore.onrender.com/user';
  const payload = { wallet: walletAddress, invite: null };
  const response = await requestWithRetry('post', url, payload, getAxiosConfig(proxy));
  return response.data.token;
}

async function loginUser(walletAddress, proxy, initialToken) {
  const url = 'https://mscore.onrender.com/user/login';
  const payload = { wallet: walletAddress };
  const response = await requestWithRetry('post', url, payload, getAxiosConfig(proxy, initialToken));
  return response.data.token;
}

async function claimTask(walletAddress, taskId, proxy, token) {
  const url = 'https://mscore.onrender.com/user/claim-task';
  const payload = { wallet: walletAddress, taskId };
  try {
    const response = await requestWithRetry('post', url, payload, getAxiosConfig(proxy, token));
    return response.data && response.data.message
      ? response.data.message
      : '任务领取成功，但服务器未返回消息。';
  } catch (error) {
    return `领取任务 ${taskId} 失败: ${error.response?.data?.message || error.message}`;
  }
}

async function updateStartTime(walletAddress, proxy, token) {
  const url = 'https://mscore.onrender.com/user/update-start-time';
  const payload = { wallet: walletAddress, startTime: Date.now() };
  try {
    const response = await requestWithRetry('put', url, payload, getAxiosConfig(proxy, token));
    const message = response.data && response.data.message ? response.data.message : '启动节点成功';
    const totalPoints =
      response.data && response.data.user && response.data.user.totalPoints !== undefined
        ? response.data.user.totalPoints
        : '未知';
    return { message, totalPoints };
  } catch (error) {
    const message = `启动节点失败: ${error.response?.data?.message || error.message}`;
    const totalPoints =
      error.response && error.response.data && error.response.data.user && error.response.data.user.totalPoints !== undefined
        ? error.response.data.user.totalPoints
        : 'N/A';
    return { message, totalPoints };
  }
}

async function processAccount(account, index, total, proxy) {
  const { walletAddress, privateKey } = account;
  console.log(`\n`);
  console.log(chalk.bold.cyanBright('='.repeat(80)));
  console.log(chalk.bold.whiteBright(`账户: ${index + 1}/${total}`));
  console.log(chalk.bold.whiteBright(`钱包地址: ${walletAddress}`));
  const usedIP = await getPublicIP(proxy);
  console.log(chalk.bold.whiteBright(`使用的 IP: ${usedIP}`));
  console.log(chalk.bold.cyanBright('='.repeat(80)));

  let wallet;
  try {
    wallet = new Wallet(privateKey);
  } catch (error) {
    console.error(chalk.red(`错误: ${error.message}`));
    return;
  }

  const spinnerAuth = ora({ text: '正在进行身份验证...', spinner: 'dots2', color: 'cyan' }).start();
  let loginToken;
  try {
    const initialToken = await getInitialToken(walletAddress, proxy);
    spinnerAuth.text = '正在签名钱包...';
    await delay(0.5);

    const signMessage = `来自 monadscore.xyz 的请求

消息

签名此消息以验证所有权并继续前往仪表板！

${walletAddress}`;
    await wallet.signMessage(signMessage);
    spinnerAuth.text = '签名成功';
    await delay(0.5);

    loginToken = await loginUser(walletAddress, proxy, initialToken);
    spinnerAuth.succeed(chalk.greenBright('身份验证成功'));
  } catch (error) {
    spinnerAuth.fail(chalk.redBright(`身份验证失败: ${error.message}`));
    return;
  }

  const tasks = ['task003', 'task002', 'task001'];
  for (let i = 0; i < tasks.length; i++) {
    const spinnerTask = ora({ text: `正在领取任务 ${i + 1}/3 ...`, spinner: 'dots2', color: 'cyan' }).start();
    const msg = await claimTask(walletAddress, tasks[i], proxy, loginToken);
    if (msg.toLowerCase().includes('successfully') || msg.toLowerCase().includes('成功')) {
      spinnerTask.succeed(chalk.greenBright(`领取任务 ${i + 1}/3 成功`));
    } else {
      spinnerTask.fail(chalk.redBright(` ${msg}`));
    }
  }

  const spinnerStart = ora({ text: '正在启动节点...', spinner: 'dots2', color: 'cyan' }).start();
  const { message, totalPoints } = await updateStartTime(walletAddress, proxy, loginToken);
  if (message.toLowerCase().includes('successfully') || message.toLowerCase().includes('成功')) {
    spinnerStart.succeed(chalk.greenBright(`启动节点成功: ${message}`));
  } else {
    spinnerStart.fail(chalk.red(`启动节点失败: ${message}`));
  }

  const spinnerPoints = ora({ text: '正在获取总积分...', spinner: 'dots2', color: 'cyan' }).start();
  spinnerPoints.succeed(chalk.greenBright(`总积分: ${totalPoints}`));
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function run() {
  cfonts.say('MonadScore', {
    font: 'block',
    align: 'center',
    colors: ['cyan', 'magenta'],
    background: 'transparent',
    letterSpacing: 1,
    lineHeight: 1,
    space: true,
    maxLength: '0'
  });
  console.log(centerText("=== 关注推特 @moon199072 ===\n"));

  const useProxyAns = await askQuestion('是否使用代理？(y/n): ');
  let proxies = [];
  let useProxy = false;
  if (useProxyAns.trim().toLowerCase() === 'y') {
    useProxy = true;
    proxies = await readProxies();
    if (proxies.length === 0) {
      console.log(chalk.yellow('proxy.txt 中没有代理，继续不使用代理运行。'));
      useProxy = false;
    }
  }

  const accounts = await readAccounts();
  if (accounts.length === 0) {
    console.log(chalk.red('accounts.json 中没有账户。'));
    return;
  }

  for (let i = 0; i < accounts.length; i++) {
    const proxy = useProxy ? proxies[i % proxies.length] : null;
    try {
      await processAccount(accounts[i], i, accounts.length, proxy);
    } catch (error) {
      console.error(chalk.red(`账户 ${i + 1} 处理出错: ${error.message}`));
    }
  }

  console.log(chalk.magentaBright('循环完成，将等待24小时后重新运行...'));
  await delay(86400);
  run();
}

run();