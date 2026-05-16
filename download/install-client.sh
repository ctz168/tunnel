#!/bin/bash
# ============================================================
#  TunnelNet Client - 一键安装脚本
#  适用: Linux / macOS / WSL / Windows(WSL)
#  用法: bash install-client.sh
# ============================================================
set -e

INSTALL_DIR="$HOME/.tunnelnet"

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║      TunnelNet Client 一键安装               ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

# ---- 安装 Bun ----
echo "  [1/3] 检查 Bun..."

if command -v bun &>/dev/null; then
  echo "  Bun 已安装: $(bun --version)"
else
  echo "  安装 Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  echo "  Bun 安装完成: $(bun --version)"
fi

# ---- 创建客户端目录 ----
echo "  [2/3] 安装客户端..."

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# 初始化项目（仅安装 ws 依赖）
if [ ! -f "package.json" ]; then
  cat > package.json << 'PKGJSON'
{
  "name": "tunnelnet-client",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "ws": "^8.18.0"
  }
}
PKGJSON
fi

bun install

# 下载/更新客户端脚本
if [ ! -f "tunnelnet" ]; then
  cat > tunnelnet << 'CLIENTSCRIPT'
#!/usr/bin/env bun
/**
 * TunnelNet Client - 内网穿透客户端（纯 CLI）
 */
import WebSocket from 'ws';
import http from 'http';

interface ClientConfig { server: string; key: string; localPort: number; localHost: string; }

function parseArgs(): ClientConfig {
  const args = process.argv.slice(2);
  const cfg: Partial<ClientConfig> = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--server': case '-s': cfg.server = args[++i]; break;
      case '--key': case '-k': cfg.key = args[++i]; break;
      case '--port': case '-p': cfg.localPort = parseInt(args[++i], 10); break;
      case '--host': case '-h': cfg.localHost = args[++i]; break;
      case '--help': console.log('\n  TunnelNet Client v1.0\n  用法: tunnelnet --key <8位密钥> --port <端口>\n  参数: -k 密钥(必填) -p 端口(必填) -s 服务器(默认: aicq.online:7739) -h 本地地址(默认: localhost)\n'); process.exit(0);
    }
  }
  if (!cfg.key || !cfg.localPort) { console.error('\n  用法: tunnelnet --key <8位密钥> --port <端口>\n  运行 tunnelnet --help 查看帮助\n'); process.exit(1); }
  return { server: cfg.server || 'aicq.online:7739', key: cfg.key!.toUpperCase().trim(), localPort: cfg.localPort!, localHost: cfg.localHost || 'localhost' };
}

class TunnelClient {
  private cfg: ClientConfig;
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reqCount = 0;
  private startTime = Date.now();
  private statusIv: ReturnType<typeof setInterval> | null = null;
  private retryCount = 0;

  constructor(c: ClientConfig) { this.cfg = c; }

  start() {
    console.log(`\n  TunnelNet Client v1.0\n  服务器: ${this.cfg.server}\n  密钥: ${this.cfg.key}\n  本地: ${this.cfg.localHost}:${this.cfg.localPort}\n`);
    this.connect();
  }

  private connect() {
    const base = this.cfg.server.startsWith('http') ? this.cfg.server : `http://${this.cfg.server}`;
    const wsUrl = base.replace(/^http/, 'ws') + `/ws?key=${encodeURIComponent(this.cfg.key)}`;
    try { this.ws = new WebSocket(wsUrl); } catch(e) { console.error(`  [错误] ${e}`); this.reconnect(); return; }
    this.ws.on('open', () => { this.retryCount = 0; this.startStatus(); });
    this.ws.on('message', (d) => { try { const m = JSON.parse(d.toString()); if(m.type==='connected'){console.log(`  [OK] 公网地址: ${m.publicUrl}\n`);}else if(m.type==='ping'){this.ws?.send('{"type":"pong"}');}else if(m.type==='request'){this.proxy(m);}else if(m.type==='error'){console.error(`  [错误] ${m.message}`);}}catch{} });
    this.ws.on('close', (c) => { if(this.statusIv)clearInterval(this.statusIv); console.log(`  [断开] code:${c}`); this.reconnect(); });
    this.ws.on('error', (e) => { console.error(`  [错误] ${e.message}`); });
  }

  private proxy(m: {id:string;method:string;url:string;headers:Record<string,string>;body?:string}) {
    const body = m.body ? Buffer.from(m.body, 'base64') : undefined;
    const hdr: Record<string,string> = {};
    for(const [k,v] of Object.entries(m.headers)){if(typeof v==='string'&&!['host','connection','transfer-encoding'].includes(k)) hdr[k]=v;}
    const req = http.request({hostname:this.cfg.localHost,port:this.cfg.localPort,path:m.url,method:m.method,headers:hdr},(res)=>{
      const c:Buffer[]=[];res.on('data',(ch:Buffer)=>c.push(ch));res.on('end',()=>{
        const b=Buffer.concat(c);const h:Record<string,string>={};
        for(const [k,v] of Object.entries(res.headers)){if(typeof v==='string'&&!['transfer-encoding','connection'].includes(k)) h[k]=v;}
        this.ws?.send(JSON.stringify({type:'response',id:m.id,statusCode:res.statusCode,headers:h,body:b.toString('base64')}));this.reqCount++;
      });
    });
    req.on('error',(e)=>{this.ws?.send(JSON.stringify({type:'response',id:m.id,statusCode:502,headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify({error:'本地服务不可用'})).toString('base64')}));});
    if(body)req.write(body);req.end();
  }

  private reconnect() { if(this.timer)return;const d=Math.min(1000*Math.pow(2,Math.min(this.retryCount,5)),30000);this.retryCount++;console.log(`  [重连] ${Math.round(d/1000)}s 后...`);this.timer=setTimeout(()=>{this.timer=null;this.connect();},d); }
  private startStatus() { if(this.statusIv)clearInterval(this.statusIv);this.statusIv=setInterval(()=>{const u=Math.floor((Date.now()-this.startTime)/1000);const h=Math.floor(u/3600);const m=Math.floor((u%3600)/60);const s=u%60;console.log(`  [状态] ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} | 请求:${this.reqCount} | http://${this.cfg.server}/${this.cfg.key}`);},60000); }
}

const c=parseArgs();new TunnelClient(c).start();
process.on('SIGINT',()=>{console.log('\n  关闭...');process.exit(0);});
CLIENTSCRIPT
fi

chmod +x "$INSTALL_DIR/tunnelnet"

# ---- 创建符号链接到 PATH ----
echo "  [3/3] 配置命令..."

LINK_DIR="$HOME/.local/bin"
mkdir -p "$LINK_DIR"

if [ ! -L "$LINK_DIR/tunnelnet" ]; then
  ln -sf "$INSTALL_DIR/tunnelnet" "$LINK_DIR/tunnelnet"
fi

# 检查是否在 PATH 中
if ! echo "$PATH" | grep -q "$LINK_DIR"; then
  echo ""
  echo "  [提示] 请将以下行添加到 ~/.bashrc 或 ~/.zshrc:"
  echo '    export PATH="$HOME/.local/bin:$PATH"'
  echo ""
  export PATH="$LINK_DIR:$PATH"
fi

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║          安装完成！                          ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""
echo "  使用方法:"
echo "    tunnelnet --key <8位密钥> --port <本地端口>"
echo ""
echo "  示例:"
echo "    tunnelnet --key ABCD1234 --port 8080"
echo "    tunnelnet -k ABCD1234 -p 8080 -s aicq.online:7739"
echo "    tunnelnet -k ABCD1234 -p 3000 -h 192.168.1.100"
echo ""
