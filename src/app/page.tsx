"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Wifi, Activity, Trash2, Copy, Settings,
  ChevronRight, RefreshCw, Server, Shield, Zap, Hash, Info,
  X, CheckCircle, AlertCircle, Loader2, Key, Link2,
  Monitor, Terminal, Globe, WifiOff, ExternalLink,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface Tunnel {
  id: string; name: string; tunnelCode: string; localPort: number; localHost: string;
  authToken: string; protocol: string; status: string; maxConn: number;
  description: string | null; createdAt: string; updatedAt: string;
  serverStatus: { online: boolean; connectedAt?: string; bytesIn?: number; bytesOut?: number; requestCount?: number; } | null;
  publicUrl: string;
}

interface TunnelLog { id: string; tunnelId: string; action: string; message: string; ip: string | null; bytesIn: number; bytesOut: number; createdAt: string; }

function formatBytes(b: number): string {
  if (b === 0) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + " " + s[i];
}
function formatTime(d: string): string {
  return new Date(d).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function timeAgo(d: string): string {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

// 内联 toast 系统（不依赖 shadcn Toaster）
function useToast() {
  const [toasts, setToasts] = useState<{ id: string; message: string; type: "success" | "error" }[]>([]);
  const addToast = useCallback((message: string, type: "success" | "error" = "success") => {
    const id = Date.now().toString();
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3000);
  }, []);
  return { toasts, addToast };
}

export default function DashboardPage() {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [serverDomain, setServerDomain] = useState("aicq.online:1018");
  const [serverOnline, setServerOnline] = useState<boolean | null>(null); // null=检测中
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedTunnel, setSelectedTunnel] = useState<Tunnel | null>(null);
  const [logs, setLogs] = useState<TunnelLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const { toasts, addToast } = useToast();

  // 创建表单
  const [formName, setFormName] = useState("");
  const [formPort, setFormPort] = useState("");
  const [formHost, setFormHost] = useState("localhost");
  const [formDesc, setFormDesc] = useState("");
  const [creating, setCreating] = useState(false);

  // 设置表单
  const [settingsDomain, setSettingsDomain] = useState("aicq.online:1018");
  const [savingSettings, setSavingSettings] = useState(false);

  const fetchTunnels = useCallback(async () => {
    try {
      const res = await fetch("/api/tunnels");
      if (res.ok) {
        const d = await res.json();
        setTunnels(d.tunnels || []);
        setServerDomain(d.serverDomain || "aicq.online:1018");
      }
    } catch { /* 静默 */ }
    try {
      const r = await fetch("/api/tunnel-status");
      setServerOnline(r.ok);
    } catch {
      setServerOnline(false);
    }
    setLoading(false);
  }, []);

  const fetchLogs = useCallback(async (id: string) => {
    setLogsLoading(true);
    try {
      const r = await fetch(`/api/tunnels/${id}/logs?limit=30`);
      if (r.ok) setLogs((await r.json()).logs || []);
    } catch { /* 静默 */ }
    setLogsLoading(false);
  }, []);

  // 定时刷新
  useEffect(() => {
    fetchTunnels();
    const iv = setInterval(fetchTunnels, 5000);
    return () => clearInterval(iv);
  }, [fetchTunnels]);

  useEffect(() => {
    if (selectedTunnel) {
      fetchLogs(selectedTunnel.id);
      const iv = setInterval(() => fetchLogs(selectedTunnel.id), 8000);
      return () => clearInterval(iv);
    } else {
      setLogs([]);
    }
  }, [selectedTunnel, fetchLogs]);

  const handleCreate = async () => {
    if (!formName.trim()) { addToast("请填写隧道名称", "error"); return; }
    if (!formPort.trim() || isNaN(Number(formPort)) || Number(formPort) < 1 || Number(formPort) > 65535) {
      addToast("请填写有效的端口号 (1-65535)", "error"); return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/tunnels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: formName.trim(), localPort: parseInt(formPort), localHost: formHost.trim() || "localhost", description: formDesc.trim() || null }),
      });
      if (res.ok) {
        addToast("隧道创建成功！");
        setCreateOpen(false);
        setFormName(""); setFormPort(""); setFormHost("localhost"); setFormDesc("");
        fetchTunnels();
      } else {
        const d = await res.json().catch(() => ({}));
        addToast(d.error || "创建失败", "error");
      }
    } catch { addToast("网络错误", "error"); }
    setCreating(false);
  };

  const handleSaveSettings = async () => {
    if (!settingsDomain.trim()) { addToast("域名不能为空", "error"); return; }
    setSavingSettings(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverDomain: settingsDomain.trim() }),
      });
      if (res.ok) {
        addToast("服务器配置已更新");
        setServerDomain(settingsDomain.trim());
        setSettingsOpen(false);
        fetchTunnels();
      } else {
        const d = await res.json().catch(() => ({}));
        addToast(d.error || "保存失败", "error");
      }
    } catch { addToast("网络错误", "error"); }
    setSavingSettings(false);
  };

  const handleDelete = async (id: string) => {
    try {
      const r = await fetch(`/api/tunnels/${id}`, { method: "DELETE" });
      if (r.ok) {
        addToast("隧道已删除");
        if (selectedTunnel?.id === id) setSelectedTunnel(null);
        fetchTunnels();
      } else {
        addToast("删除失败", "error");
      }
    } catch { addToast("网络错误", "error"); }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => addToast("已复制"),
      () => {
        // fallback
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        addToast("已复制");
      }
    );
  };

  const getClientCommand = (t: Tunnel) => `bun tunnel-client.ts --key ${t.tunnelCode} --port ${t.localPort}`;
  const getPublicUrl = (t: Tunnel) => `http://${serverDomain}/${t.tunnelCode}`;

  const onlineCount = tunnels.filter(t => t.serverStatus?.online).length;
  const totalRequests = tunnels.reduce((s, t) => s + (t.serverStatus?.requestCount || 0), 0);
  const totalBytes = tunnels.reduce((s, t) => s + (t.serverStatus?.bytesIn || 0) + (t.serverStatus?.bytesOut || 0), 0);

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 100, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 100, scale: 0.95 }}
              className="pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg border bg-white dark:bg-slate-800 text-sm max-w-xs"
            >
              {t.type === "success" ? <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" /> : <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />}
              <span className="break-all">{t.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-white/80 dark:bg-slate-900/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md">
                <Zap className="h-4 w-4 text-white" />
              </div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight">TunnelNet</h1>
                <code className="hidden sm:inline text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{serverDomain}</code>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={serverOnline === true ? "default" : "secondary"}
                className={`text-xs gap-1 ${serverOnline === true ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900" : serverOnline === false ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900" : "bg-slate-100 text-slate-500"}`}
              >
                <div className={`w-1.5 h-1.5 rounded-full ${serverOnline === true ? "bg-emerald-500 animate-pulse" : serverOnline === false ? "bg-red-500" : "bg-slate-400 animate-pulse"}`} />
                {serverOnline === null ? "检测中" : serverOnline ? "在线" : "离线"}
              </Badge>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setSettingsDomain(serverDomain); setSettingsOpen(true); }}>
                <Settings className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={fetchTunnels} className="gap-1.5">
                <RefreshCw className="h-3 w-3" />
                <span className="hidden sm:inline">刷新</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5">
        {/* Stats Cards */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          {/* Online Tunnels */}
          <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0 }}>
            <Card className="border-0 shadow-sm bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">在线隧道</p>
                    <p className="text-xl sm:text-2xl font-bold text-emerald-600 dark:text-emerald-400">{onlineCount}</p>
                  </div>
                  <div className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center">
                    <Wifi className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* Traffic */}
          <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <Card className="border-0 shadow-sm bg-gradient-to-br from-blue-50 to-sky-50 dark:from-blue-950/30 dark:to-sky-950/30">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">数据流量</p>
                    <p className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400">{formatBytes(totalBytes)}</p>
                  </div>
                  <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center">
                    <Activity className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* Total Requests */}
          <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <Card className="border-0 shadow-sm bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">总请求</p>
                    <p className="text-xl sm:text-2xl font-bold text-amber-600 dark:text-amber-400">{totalRequests}</p>
                  </div>
                  <div className="w-9 h-9 rounded-lg bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
                    <Hash className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Empty State */}
        {tunnels.length === 0 && !loading && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="mb-5 border-0 shadow-sm">
              <CardContent className="p-6 text-center py-12">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg mx-auto mb-4">
                  <Globe className="h-8 w-8 text-white" />
                </div>
                <h2 className="text-lg font-bold mb-2">创建第一个隧道</h2>
                <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
                  自动分配 8 位密钥，将内网服务映射到公网地址
                  <br />
                  <code className="text-xs mt-1 inline-block">
                    http://{serverDomain}/<span className="text-emerald-600 font-bold">XXXXXXXX</span>
                  </code>
                </p>
                <Button size="lg" onClick={() => setCreateOpen(true)} className="gap-2 shadow-md">
                  <Plus className="h-4 w-4" />
                  创建隧道
                </Button>
                <div className="mt-8 flex justify-center gap-8 text-xs text-muted-foreground">
                  <div className="flex flex-col items-center gap-1">
                    <div className="w-8 h-8 rounded-full bg-emerald-50 dark:bg-emerald-950/30 flex items-center justify-center">
                      <Key className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <span>8位密钥认证</span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <div className="w-8 h-8 rounded-full bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center">
                      <Link2 className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                    </div>
                    <span>固定公网地址</span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <div className="w-8 h-8 rounded-full bg-purple-50 dark:bg-purple-950/30 flex items-center justify-center">
                      <Shield className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                    </div>
                    <span>WebSocket 加密传输</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* List + Detail Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Tunnel List */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold flex items-center gap-2">
                隧道列表
                {!loading && tunnels.length > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">{tunnels.length} 个</span>
                )}
              </h2>
              <Dialog open={createOpen} onOpenChange={(open) => {
                setCreateOpen(open);
                if (!open) { setFormName(""); setFormPort(""); setFormHost("localhost"); setFormDesc(""); }
              }}>
                <DialogTrigger asChild>
                  <Button className="gap-1.5" size="sm">
                    <Plus className="h-3.5 w-3.5" />
                    新建
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>创建隧道</DialogTitle>
                    <DialogDescription>自动分配 8 位公网密钥，将本地服务映射到公网。</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="tname">隧道名称 *</Label>
                      <Input id="tname" placeholder="例如: 我的网站" value={formName} onChange={e => setFormName(e.target.value)} onKeyDown={e => e.key === "Enter" && handleCreate()} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label htmlFor="thost">本地地址</Label>
                        <Input id="thost" placeholder="localhost" value={formHost} onChange={e => setFormHost(e.target.value)} />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="tport">本地端口 *</Label>
                        <Input id="tport" placeholder="8080" type="number" min="1" max="65535" value={formPort} onChange={e => setFormPort(e.target.value)} onKeyDown={e => e.key === "Enter" && handleCreate()} />
                      </div>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="tdesc">描述（可选）</Label>
                      <Textarea id="tdesc" placeholder="例如: 开发环境前端" value={formDesc} onChange={e => setFormDesc(e.target.value)} rows={2} />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
                    <Button onClick={handleCreate} disabled={creating} className="gap-2">
                      {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                      创建
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {/* Loading Skeleton */}
            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => (
                  <Card key={i} className="shadow-sm">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <Skeleton className="h-9 w-9 rounded-lg" />
                        <div className="space-y-1.5">
                          <Skeleton className="h-3.5 w-28" />
                          <Skeleton className="h-3 w-44" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : tunnels.length === 0 ? null : (
              <div className="space-y-2">
                <AnimatePresence mode="popLayout">
                  {tunnels.map(tunnel => {
                    const on = tunnel.serverStatus?.online || false;
                    return (
                      <motion.div
                        key={tunnel.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -80, height: 0 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Card
                          className={`shadow-sm cursor-pointer transition-all hover:shadow-md ${
                            selectedTunnel?.id === tunnel.id
                              ? "ring-2 ring-emerald-500/50 border-emerald-200 dark:border-emerald-800"
                              : "hover:border-slate-300 dark:hover:border-slate-600"
                          }`}
                          onClick={() => setSelectedTunnel(selectedTunnel?.id === tunnel.id ? null : tunnel)}
                        >
                          <CardContent className="p-3 sm:p-4">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3 min-w-0 flex-1">
                                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors ${on ? "bg-emerald-100 dark:bg-emerald-900/50" : "bg-slate-100 dark:bg-slate-800"}`}>
                                  {on ? (
                                    <Wifi className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                                  ) : (
                                    <WifiOff className="h-4 w-4 text-slate-400" />
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <h3 className="font-semibold text-sm truncate">{tunnel.name}</h3>
                                    <Badge
                                      variant={on ? "default" : "secondary"}
                                      className={`text-[10px] px-1.5 py-0 shrink-0 ${
                                        on
                                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900"
                                          : ""
                                      }`}
                                    >
                                      {on ? "在线" : "离线"}
                                    </Badge>
                                  </div>
                                  <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                                    <code className="bg-muted px-1 py-0 rounded font-mono text-[11px]">{tunnel.tunnelCode}</code>
                                    <span>→</span>
                                    <span className="truncate">{tunnel.localHost}:{tunnel.localPort}</span>
                                    {on && tunnel.serverStatus?.requestCount !== undefined && (
                                      <>
                                        <span className="text-muted-foreground/50">|</span>
                                        <span className="text-blue-600 dark:text-blue-400">{tunnel.serverStatus.requestCount} 请求</span>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <ChevronRight className={`h-4 w-4 shrink-0 ml-2 transition-transform text-muted-foreground ${selectedTunnel?.id === tunnel.id ? "rotate-90" : ""}`} />
                            </div>
                          </CardContent>
                        </Card>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </div>

          {/* Detail Panel */}
          <div className="lg:col-span-1">
            <div className="lg:sticky lg:top-16">
              {selectedTunnel ? (
                <motion.div initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }}>
                  <Card className="shadow-sm">
                    <CardHeader className="pb-2 px-4 pt-4">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm">隧道详情</CardTitle>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedTunnel(null)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3 px-4 pb-4">
                      {/* Status Banner */}
                      <div className={`p-2.5 rounded-lg text-sm ${selectedTunnel.serverStatus?.online ? "bg-emerald-50 dark:bg-emerald-950/30" : "bg-slate-50 dark:bg-slate-900/50"}`}>
                        <div className="flex items-center gap-2">
                          {selectedTunnel.serverStatus?.online ? (
                            <CheckCircle className="h-4 w-4 text-emerald-500" />
                          ) : (
                            <AlertCircle className="h-4 w-4 text-slate-400" />
                          )}
                          <span className={selectedTunnel.serverStatus?.online ? "text-emerald-700 dark:text-emerald-300 font-medium" : "text-muted-foreground"}>
                            {selectedTunnel.serverStatus?.online ? "隧道运行中" : "隧道离线"}
                          </span>
                          {selectedTunnel.serverStatus?.connectedAt && (
                            <span className="text-xs text-muted-foreground ml-auto">{timeAgo(selectedTunnel.serverStatus.connectedAt)}</span>
                          )}
                        </div>
                      </div>

                      {/* Public URL */}
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">公网地址</p>
                        <div className="relative group">
                          <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-2.5 flex items-center gap-2">
                            <Globe className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                            <code className="text-xs text-emerald-700 dark:text-emerald-300 font-mono break-all">{getPublicUrl(selectedTunnel)}</code>
                          </div>
                          <div className="absolute top-1.5 right-1.5 flex gap-0.5">
                            <Button
                              variant="ghost" size="icon" className="h-6 w-6 text-slate-400 hover:text-emerald-600"
                              onClick={(e) => { e.stopPropagation(); copy(getPublicUrl(selectedTunnel)); }}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost" size="icon" className="h-6 w-6 text-slate-400 hover:text-emerald-600"
                              onClick={(e) => { e.stopPropagation(); window.open(getPublicUrl(selectedTunnel), "_blank"); }}
                            >
                              <ExternalLink className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      </div>

                      {/* Info Grid */}
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">名称</span>
                          <span className="font-medium text-right truncate max-w-[160px]">{selectedTunnel.name}</span>
                        </div>
                        <Separator />
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground">密钥</span>
                          <code className="bg-muted px-1.5 py-0.5 rounded font-mono font-bold tracking-wider text-emerald-600 dark:text-emerald-400">{selectedTunnel.tunnelCode}</code>
                        </div>
                        <Separator />
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">本地地址</span>
                          <code className="bg-muted px-1.5 py-0.5 rounded">{selectedTunnel.localHost}:{selectedTunnel.localPort}</code>
                        </div>
                        <Separator />
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">创建时间</span>
                          <span>{formatTime(selectedTunnel.createdAt)}</span>
                        </div>
                        {selectedTunnel.description && (
                          <>
                            <Separator />
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">描述</span>
                              <span className="text-right truncate max-w-[160px]">{selectedTunnel.description}</span>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Real-time Traffic */}
                      {selectedTunnel.serverStatus?.online && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">实时流量</p>
                          <div className="grid grid-cols-3 gap-1.5">
                            <div className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-center">
                              <p className="text-[10px] text-muted-foreground">入站</p>
                              <p className="text-xs font-semibold text-blue-600 dark:text-blue-400">{formatBytes(selectedTunnel.serverStatus.bytesIn || 0)}</p>
                            </div>
                            <div className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-center">
                              <p className="text-[10px] text-muted-foreground">出站</p>
                              <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">{formatBytes(selectedTunnel.serverStatus.bytesOut || 0)}</p>
                            </div>
                            <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 text-center">
                              <p className="text-[10px] text-muted-foreground">请求</p>
                              <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">{selectedTunnel.serverStatus.requestCount || 0}</p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Client Command */}
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">客户端命令</p>
                        <div className="relative group">
                          <div className="bg-slate-900 dark:bg-slate-950 rounded-lg p-2.5 overflow-x-auto">
                            <code className="text-[11px] text-emerald-400 font-mono whitespace-nowrap">{getClientCommand(selectedTunnel)}</code>
                          </div>
                          <Button
                            variant="ghost" size="icon"
                            className="absolute top-1.5 right-1.5 h-6 w-6 text-slate-500 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); copy(getClientCommand(selectedTunnel)); }}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2 pt-1">
                        <Button variant="outline" className="flex-1 gap-1.5" size="sm" onClick={(e) => { e.stopPropagation(); copy(selectedTunnel.authToken); }}>
                          <Shield className="h-3 w-3" />
                          复制Token
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="outline"
                              className="gap-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                              size="sm"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Trash2 className="h-3 w-3" />
                              删除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>确认删除</AlertDialogTitle>
                              <AlertDialogDescription>
                                确定删除「{selectedTunnel.name}」？已连接的客户端将断开，此操作无法撤销。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => handleDelete(selectedTunnel.id)}>
                                删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>

                      {/* Logs */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            日志
                            {!logsLoading && logs.length > 0 && <span className="text-muted-foreground/50 ml-1">({logs.length})</span>}
                          </p>
                          <Button
                            variant="ghost" size="sm" className="h-5 text-[10px] gap-1 px-1.5"
                            onClick={() => fetchLogs(selectedTunnel.id)}
                          >
                            <RefreshCw className={logsLoading ? "h-2.5 w-2.5 animate-spin" : "h-2.5 w-2.5"} />
                          </Button>
                        </div>
                        <ScrollArea className="h-40 rounded-lg border bg-slate-50 dark:bg-slate-900/50">
                          <div className="p-1.5 space-y-0.5">
                            {logsLoading && logs.length === 0 ? (
                              <div className="space-y-1.5 p-1">
                                {[1, 2, 3].map(i => <Skeleton key={i} className="h-3 w-full" />)}
                              </div>
                            ) : logs.length === 0 ? (
                              <div className="flex flex-col items-center justify-center py-6">
                                <Info className="h-4 w-4 text-muted-foreground/40 mb-1" />
                                <p className="text-xs text-muted-foreground">暂无日志</p>
                              </div>
                            ) : (
                              logs.map(l => {
                                const dotColor = l.action === "connect" ? "bg-emerald-500" : l.action === "disconnect" ? "bg-red-500" : l.action === "request" ? "bg-blue-500" : l.action === "error" ? "bg-amber-500" : "bg-slate-400";
                                return (
                                  <div key={l.id} className="flex items-start gap-1.5 px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                                    <div className={"w-1 h-1 rounded-full mt-1.5 shrink-0 " + dotColor} />
                                    <div className="min-w-0">
                                      <p className="text-[11px] text-muted-foreground break-all leading-relaxed">{l.message}</p>
                                      <p className="text-[10px] text-muted-foreground/50">{formatTime(l.createdAt)}</p>
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </ScrollArea>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ) : (
                <Card className="shadow-sm">
                  <CardContent className="p-5">
                    <div className="text-center py-8">
                      <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center mx-auto mb-3">
                        <Info className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <p className="text-sm font-medium text-muted-foreground">选择隧道查看详情</p>
                      <p className="text-xs text-muted-foreground/60 mt-1">点击左侧隧道卡片查看连接信息、实时流量和日志</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>

        {/* Quick Start Guide */}
        <div className="mt-6">
          <Card className="shadow-sm border-0 bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-900/30 dark:to-slate-800/30">
            <CardContent className="p-5">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-slate-200 dark:bg-slate-700 flex items-center justify-center shrink-0">
                  <Server className="h-4 w-4 text-slate-600 dark:text-slate-300" />
                </div>
                <div className="space-y-2 flex-1 min-w-0">
                  <h3 className="text-sm font-semibold">快速开始</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="bg-white/60 dark:bg-slate-800/60 rounded-lg p-3 border">
                      <div className="flex items-center gap-1.5 mb-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                        <Monitor className="h-3 w-3" />
                        服务端部署
                      </div>
                      <code className="text-[11px] text-muted-foreground block bg-slate-900 text-emerald-400 rounded px-2 py-1 mt-1 font-mono overflow-x-auto">
                        curl -fsSL https://get.tunnelnet.sh | bash
                      </code>
                    </div>
                    <div className="bg-white/60 dark:bg-slate-800/60 rounded-lg p-3 border">
                      <div className="flex items-center gap-1.5 mb-1.5 font-medium text-blue-700 dark:text-blue-400">
                        <Terminal className="h-3 w-3" />
                        客户端运行
                      </div>
                      <code className="text-[11px] text-muted-foreground block bg-slate-900 text-emerald-400 rounded px-2 py-1 mt-1 font-mono overflow-x-auto">
                        bun tunnel-client.ts --key XXXX -p 8080
                      </code>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Settings Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              <Settings className="h-4 w-4 inline mr-2" />
              服务器设置
            </DialogTitle>
            <DialogDescription>配置隧道服务器的公网域名和端口，客户端将通过此域名访问隧道。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sdomain">服务器域名</Label>
              <Input
                id="sdomain"
                placeholder="aicq.online:1018"
                value={settingsDomain}
                onChange={e => setSettingsDomain(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSaveSettings()}
              />
              <p className="text-xs text-muted-foreground">格式: 域名:端口，例如 aicq.online:1018</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>取消</Button>
            <Button onClick={handleSaveSettings} disabled={savingSettings} className="gap-2">
              {savingSettings && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Footer */}
      <footer className="border-t py-3 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-[11px] text-muted-foreground text-center">
            TunnelNet - 内网穿透服务 | http://<span className="font-mono">{serverDomain}</span>/&lt;8位密钥&gt;
          </p>
        </div>
      </footer>
    </div>
  );
}
