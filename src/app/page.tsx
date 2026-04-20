"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  Wifi,
  WifiOff,
  Globe,
  Activity,
  Trash2,
  Copy,
  Terminal,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Server,
  Shield,
  Zap,
  ArrowUpDown,
  Clock,
  Hash,
  Info,
  X,
  CheckCircle,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// Types
interface Tunnel {
  id: string;
  name: string;
  subdomain: string;
  localPort: number;
  localHost: string;
  authToken: string;
  protocol: string;
  status: string;
  maxConn: number;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  serverStatus: {
    online: boolean;
    connectedAt?: string;
    bytesIn?: number;
    bytesOut?: number;
    requestCount?: number;
  } | null;
}

interface TunnelLog {
  id: string;
  tunnelId: string;
  action: string;
  message: string;
  ip: string | null;
  bytesIn: number;
  bytesOut: number;
  createdAt: string;
}

interface ServerStatus {
  status: string;
  tunnels: Tunnel[];
}

// Utility
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

// Toast helper
function useToast() {
  const [toasts, setToasts] = useState<{ id: string; message: string; type: "success" | "error" }[]>([]);

  const addToast = useCallback((message: string, type: "success" | "error" = "success") => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return { toasts, addToast };
}

// Main page component
export default function DashboardPage() {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [serverOnline, setServerOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTunnel, setSelectedTunnel] = useState<Tunnel | null>(null);
  const [logs, setLogs] = useState<TunnelLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const { toasts, addToast } = useToast();

  // Form state
  const [formName, setFormName] = useState("");
  const [formSubdomain, setFormSubdomain] = useState("");
  const [formPort, setFormPort] = useState("");
  const [formHost, setFormHost] = useState("localhost");
  const [formProtocol, setFormProtocol] = useState("http");
  const [formDesc, setFormDesc] = useState("");
  const [creating, setCreating] = useState(false);

  // Fetch tunnels
  const fetchTunnels = useCallback(async () => {
    try {
      const res = await fetch("/api/tunnels");
      if (res.ok) {
        const data = await res.json();
        setTunnels(data.tunnels);
      }
    } catch {
      // ignore
    }
    try {
      const statusRes = await fetch("/api/tunnel-status");
      if (statusRes.ok) {
        setServerOnline(true);
      } else {
        setServerOnline(false);
      }
    } catch {
      setServerOnline(false);
    }
  }, []);

  // Fetch logs for a tunnel
  const fetchLogs = useCallback(async (tunnelId: string) => {
    setLogsLoading(true);
    try {
      const res = await fetch(`/api/tunnels/${tunnelId}/logs?limit=30`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs);
      }
    } catch {
      // ignore
    }
    setLogsLoading(false);
  }, []);

  useEffect(() => {
    const load = () => { fetchTunnels(); };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [fetchTunnels]);

  // Watch selected tunnel
  useEffect(() => {
    if (selectedTunnel) {
      const loadLogs = () => { fetchLogs(selectedTunnel.id); };
      loadLogs();
      const logInterval = setInterval(loadLogs, 8000);
      return () => clearInterval(logInterval);
    }
  }, [selectedTunnel, fetchLogs]);

  // Create tunnel
  const handleCreate = async () => {
    if (!formName || !formSubdomain || !formPort) {
      addToast("请填写所有必填字段", "error");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/tunnels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName,
          subdomain: formSubdomain,
          localPort: parseInt(formPort),
          localHost: formHost,
          protocol: formProtocol,
          description: formDesc || null,
        }),
      });
      if (res.ok) {
        addToast("隧道创建成功！");
        setCreateOpen(false);
        resetForm();
        fetchTunnels();
      } else {
        const data = await res.json();
        addToast(data.error || "创建失败", "error");
      }
    } catch {
      addToast("网络错误", "error");
    }
    setCreating(false);
  };

  // Delete tunnel
  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/tunnels/${id}`, { method: "DELETE" });
      if (res.ok) {
        addToast("隧道已删除");
        if (selectedTunnel?.id === id) setSelectedTunnel(null);
        fetchTunnels();
      } else {
        addToast("删除失败", "error");
      }
    } catch {
      addToast("网络错误", "error");
    }
  };

  // Copy to clipboard
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => addToast("已复制到剪贴板"),
      () => addToast("复制失败", "error")
    );
  };

  const resetForm = () => {
    setFormName("");
    setFormSubdomain("");
    setFormPort("");
    setFormHost("localhost");
    setFormProtocol("http");
    setFormDesc("");
  };

  // Stats
  const onlineCount = tunnels.filter((t) => {
    if (t.serverStatus?.online) return true;
    return false;
  }).length;
  const offlineCount = tunnels.length - onlineCount;
  const totalBytesIn = tunnels.reduce((sum, t) => sum + (t.serverStatus?.bytesIn || 0), 0);
  const totalBytesOut = tunnels.reduce((sum, t) => sum + (t.serverStatus?.bytesOut || 0), 0);
  const totalRequests = tunnels.reduce((sum, t) => sum + (t.serverStatus?.requestCount || 0), 0);

  // Get client command
  const getClientCommand = (tunnel: Tunnel) => {
    return `bun tunnel-client.ts --server ws://your-server.com:3002 --token ${tunnel.authToken} --subdomain ${tunnel.subdomain} --local-port ${tunnel.localPort}`;
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      {/* Toast notifications */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 100 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 100 }}
              className="flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg border bg-white dark:bg-slate-800 text-sm"
            >
              {toast.type === "success" ? (
                <CheckCircle className="h-4 w-4 text-emerald-500" />
              ) : (
                <AlertCircle className="h-4 w-4 text-red-500" />
              )}
              {toast.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-white/80 dark:bg-slate-900/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md">
                <Zap className="h-5 w-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">TunnelNet</h1>
                <p className="text-xs text-muted-foreground hidden sm:block">固定域名内网穿透</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${serverOnline ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"}`}>
                <div className={`w-2 h-2 rounded-full ${serverOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
                {serverOnline ? "服务器在线" : "服务器离线"}
              </div>
              <Button variant="outline" size="sm" onClick={fetchTunnels} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">刷新</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0 }}>
            <Card className="border-0 shadow-sm bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">在线隧道</p>
                    <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{onlineCount}</p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center">
                    <Wifi className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <Card className="border-0 shadow-sm bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900/30 dark:to-slate-800/30">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">离线隧道</p>
                    <p className="text-2xl font-bold text-slate-600 dark:text-slate-400">{offlineCount}</p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                    <WifiOff className="h-5 w-5 text-slate-500" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <Card className="border-0 shadow-sm bg-gradient-to-br from-blue-50 to-sky-50 dark:from-blue-950/30 dark:to-sky-950/30">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">数据流量</p>
                    <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{formatBytes(totalBytesIn + totalBytesOut)}</p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center">
                    <Activity className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
            <Card className="border-0 shadow-sm bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">总请求数</p>
                    <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{totalRequests}</p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
                    <Hash className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Quick Start Guide (when no tunnels) */}
        {tunnels.length === 0 && !loading && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="mb-6 border-0 shadow-sm">
              <CardContent className="p-6">
                <div className="flex flex-col items-center text-center py-8">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg mb-4">
                    <Globe className="h-8 w-8 text-white" />
                  </div>
                  <h2 className="text-xl font-bold mb-2">开始使用 TunnelNet</h2>
                  <p className="text-muted-foreground max-w-md mb-6">
                    TunnelNet 是一个类似 ngrok 的内网穿透服务，但使用固定子域名。
                    您可以为本地服务创建隧道，通过固定域名从外部访问。
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Button onClick={() => setCreateOpen(true)} className="gap-2">
                      <Plus className="h-4 w-4" />
                      创建第一个隧道
                    </Button>
                  </div>
                  <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-2xl text-left">
                    <div className="flex gap-3 p-3 rounded-lg bg-muted/50">
                      <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center shrink-0">
                        <span className="text-emerald-600 dark:text-emerald-400 font-bold text-sm">1</span>
                      </div>
                      <div>
                        <p className="text-sm font-medium">创建隧道</p>
                        <p className="text-xs text-muted-foreground">设置子域名和本地端口</p>
                      </div>
                    </div>
                    <div className="flex gap-3 p-3 rounded-lg bg-muted/50">
                      <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center shrink-0">
                        <span className="text-blue-600 dark:text-blue-400 font-bold text-sm">2</span>
                      </div>
                      <div>
                        <p className="text-sm font-medium">运行客户端</p>
                        <p className="text-xs text-muted-foreground">在本地运行连接脚本</p>
                      </div>
                    </div>
                    <div className="flex gap-3 p-3 rounded-lg bg-muted/50">
                      <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center shrink-0">
                        <span className="text-amber-600 dark:text-amber-400 font-bold text-sm">3</span>
                      </div>
                      <div>
                        <p className="text-sm font-medium">公开访问</p>
                        <p className="text-xs text-muted-foreground">通过固定域名访问服务</p>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Tunnel list + Detail panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Tunnel List */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold">隧道列表</h2>
                <p className="text-sm text-muted-foreground">管理所有内网穿透隧道</p>
              </div>
              <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogTrigger asChild>
                  <Button className="gap-2" size="sm">
                    <Plus className="h-4 w-4" />
                    新建隧道
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>创建新隧道</DialogTitle>
                    <DialogDescription>设置子域名和本地服务端口，即可创建一条固定域名的内网穿透隧道。</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="tunnel-name">隧道名称 *</Label>
                      <Input
                        id="tunnel-name"
                        placeholder="例如: 我的网站"
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="tunnel-subdomain">子域名 *</Label>
                      <div className="flex items-center gap-1">
                        <Input
                          id="tunnel-subdomain"
                          placeholder="myapp"
                          value={formSubdomain}
                          onChange={(e) => setFormSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                          className="flex-1"
                        />
                        <span className="text-sm text-muted-foreground whitespace-nowrap">.tunnel.local</span>
                      </div>
                      <p className="text-xs text-muted-foreground">只允许小写字母、数字和连字符，创建后不可修改</p>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="tunnel-host">本地地址</Label>
                        <Input
                          id="tunnel-host"
                          placeholder="localhost"
                          value={formHost}
                          onChange={(e) => setFormHost(e.target.value)}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="tunnel-port">本地端口 *</Label>
                        <Input
                          id="tunnel-port"
                          placeholder="8080"
                          type="number"
                          value={formPort}
                          onChange={(e) => setFormPort(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <Label>协议</Label>
                      <Select value={formProtocol} onValueChange={setFormProtocol}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="http">HTTP</SelectItem>
                          <SelectItem value="https">HTTPS</SelectItem>
                          <SelectItem value="tcp">TCP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="tunnel-desc">描述（可选）</Label>
                      <Textarea
                        id="tunnel-desc"
                        placeholder="例如: 开发环境前端服务"
                        value={formDesc}
                        onChange={(e) => setFormDesc(e.target.value)}
                        rows={2}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCreateOpen(false)}>
                      取消
                    </Button>
                    <Button onClick={handleCreate} disabled={creating} className="gap-2">
                      {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                      创建隧道
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Card key={i} className="shadow-sm">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-10 w-10 rounded-lg" />
                          <div className="space-y-2">
                            <Skeleton className="h-4 w-32" />
                            <Skeleton className="h-3 w-48" />
                          </div>
                        </div>
                        <Skeleton className="h-6 w-16 rounded-full" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : tunnels.length === 0 ? null : (
              <div className="space-y-3">
                <AnimatePresence>
                  {tunnels.map((tunnel) => {
                    const isOnline = tunnel.serverStatus?.online || false;
                    return (
                      <motion.div
                        key={tunnel.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -100 }}
                        transition={{ duration: 0.2 }}
                      >
                        <Card
                          className={`shadow-sm cursor-pointer transition-all hover:shadow-md ${selectedTunnel?.id === tunnel.id ? "ring-2 ring-emerald-500/50 border-emerald-200 dark:border-emerald-800" : "hover:border-slate-300 dark:hover:border-slate-600"}`}
                          onClick={() => setSelectedTunnel(tunnel)}
                        >
                          <CardContent className="p-4">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isOnline ? "bg-emerald-100 dark:bg-emerald-900/50" : "bg-slate-100 dark:bg-slate-800"}`}>
                                  <Globe className={`h-5 w-5 ${isOnline ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400"}`} />
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <h3 className="font-semibold text-sm truncate">{tunnel.name}</h3>
                                    <Badge variant={isOnline ? "default" : "secondary"} className={`text-xs px-2 py-0 ${isOnline ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900" : ""}`}>
                                      <div className={`w-1.5 h-1.5 rounded-full mr-1 ${isOnline ? "bg-emerald-500" : "bg-slate-400"}`} />
                                      {isOnline ? "在线" : "离线"}
                                    </Badge>
                                  </div>
                                  <p className="text-xs text-muted-foreground truncate">
                                    {tunnel.subdomain}.tunnel.local → {tunnel.localHost}:{tunnel.localPort}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0 ml-2">
                                {isOnline && tunnel.serverStatus?.requestCount !== undefined && (
                                  <span className="text-xs text-muted-foreground hidden sm:inline">
                                    {tunnel.serverStatus.requestCount} 请求
                                  </span>
                                )}
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              </div>
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
            <div className="sticky top-20">
              {selectedTunnel ? (
                <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}>
                  <Card className="shadow-sm">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base">隧道详情</CardTitle>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setSelectedTunnel(null)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Status badge */}
                      <div className={`p-3 rounded-lg ${selectedTunnel.serverStatus?.online ? "bg-emerald-50 dark:bg-emerald-950/30" : "bg-slate-50 dark:bg-slate-900/50"}`}>
                        <div className="flex items-center gap-2">
                          {selectedTunnel.serverStatus?.online ? (
                            <CheckCircle className="h-5 w-5 text-emerald-500" />
                          ) : (
                            <AlertCircle className="h-5 w-5 text-slate-400" />
                          )}
                          <div>
                            <p className={`text-sm font-medium ${selectedTunnel.serverStatus?.online ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}>
                              {selectedTunnel.serverStatus?.online ? "隧道运行中" : "隧道离线"}
                            </p>
                            {selectedTunnel.serverStatus?.connectedAt && (
                              <p className="text-xs text-muted-foreground">
                                连接于 {timeAgo(selectedTunnel.serverStatus.connectedAt)}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Info grid */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">名称</span>
                          <span className="font-medium">{selectedTunnel.name}</span>
                        </div>
                        <Separator />
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">子域名</span>
                          <div className="flex items-center gap-1">
                            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{selectedTunnel.subdomain}.tunnel.local</code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => copyToClipboard(`${selectedTunnel.subdomain}.tunnel.local`)}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                        <Separator />
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">本地地址</span>
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{selectedTunnel.localHost}:{selectedTunnel.localPort}</code>
                        </div>
                        <Separator />
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">协议</span>
                          <Badge variant="outline" className="text-xs">{selectedTunnel.protocol.toUpperCase()}</Badge>
                        </div>
                        <Separator />
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">创建时间</span>
                          <span className="text-xs">{formatTime(selectedTunnel.createdAt)}</span>
                        </div>
                      </div>

                      {/* Traffic stats */}
                      {selectedTunnel.serverStatus?.online && (
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">实时流量</p>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-center">
                              <p className="text-xs text-muted-foreground">入站</p>
                              <p className="text-sm font-semibold text-blue-600 dark:text-blue-400">{formatBytes(selectedTunnel.serverStatus.bytesIn || 0)}</p>
                            </div>
                            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-center">
                              <p className="text-xs text-muted-foreground">出站</p>
                              <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{formatBytes(selectedTunnel.serverStatus.bytesOut || 0)}</p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Connection command */}
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">连接命令</p>
                        <div className="relative">
                          <div className="bg-slate-900 dark:bg-slate-950 rounded-lg p-3 overflow-x-auto">
                            <code className="text-xs text-emerald-400 font-mono whitespace-nowrap">
                              {getClientCommand(selectedTunnel)}
                            </code>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute top-2 right-2 h-6 w-6 text-slate-400 hover:text-white"
                            onClick={() => copyToClipboard(getClientCommand(selectedTunnel))}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="flex-1 gap-2"
                          size="sm"
                          onClick={() => copyToClipboard(selectedTunnel.authToken)}
                        >
                          <Shield className="h-3.5 w-3.5" />
                          复制 Token
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="outline" className="gap-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30" size="sm">
                              <Trash2 className="h-3.5 w-3.5" />
                              删除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>确认删除</AlertDialogTitle>
                              <AlertDialogDescription>
                                确定要删除隧道「{selectedTunnel.name}」吗？此操作不可撤销。
                                如果客户端正在运行，连接将会断开。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-red-600 hover:bg-red-700"
                                onClick={() => handleDelete(selectedTunnel.id)}
                              >
                                确认删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>

                      {/* Logs */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">连接日志</p>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs gap-1"
                            onClick={() => fetchLogs(selectedTunnel.id)}
                          >
                            <RefreshCw className={`h-3 w-3 ${logsLoading ? "animate-spin" : ""}`} />
                            刷新
                          </Button>
                        </div>
                        <ScrollArea className="h-48 rounded-lg border bg-slate-50 dark:bg-slate-900/50">
                          <div className="p-2 space-y-1">
                            {logsLoading && logs.length === 0 ? (
                              <div className="space-y-2 p-2">
                                {[1, 2, 3, 4, 5].map((i) => (
                                  <Skeleton key={i} className="h-4 w-full" />
                                ))}
                              </div>
                            ) : logs.length === 0 ? (
                              <p className="text-xs text-muted-foreground text-center py-4">暂无日志</p>
                            ) : (
                              logs.map((log) => (
                                <div key={log.id} className="flex items-start gap-2 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
                                  <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                                    log.action === "connect" ? "bg-emerald-500" :
                                    log.action === "disconnect" ? "bg-red-500" :
                                    log.action === "request" ? "bg-blue-500" :
                                    log.action === "error" ? "bg-amber-500" :
                                    "bg-slate-400"
                                  }`} />
                                  <div className="min-w-0">
                                    <p className="text-xs text-muted-foreground break-all">{log.message}</p>
                                    <p className="text-xs text-muted-foreground/60">{formatTime(log.createdAt)}</p>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </ScrollArea>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ) : (
                <Card className="shadow-sm">
                  <CardContent className="p-6">
                    <div className="text-center py-8">
                      <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center mx-auto mb-3">
                        <Info className="h-6 w-6 text-muted-foreground" />
                      </div>
                      <p className="text-sm text-muted-foreground">选择一个隧道查看详情</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>

        {/* Architecture info */}
        <div className="mt-8 mb-4">
          <Card className="shadow-sm border-0 bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-900/30 dark:to-slate-800/30">
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-lg bg-slate-200 dark:bg-slate-700 flex items-center justify-center shrink-0">
                  <Server className="h-5 w-5 text-slate-600 dark:text-slate-300" />
                </div>
                <div className="space-y-3 flex-1">
                  <div>
                    <h3 className="font-semibold">工作原理</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      TunnelNet 通过 WebSocket 在公网服务器和本地客户端之间建立加密隧道。
                      与 ngrok 不同，TunnelNet 使用固定子域名，无需每次重新分享链接地址。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="outline" className="gap-1">
                      <Globe className="h-3 w-3" /> 固定子域名
                    </Badge>
                    <Badge variant="outline" className="gap-1">
                      <Shield className="h-3 w-3" /> Token 认证
                    </Badge>
                    <Badge variant="outline" className="gap-1">
                      <Zap className="h-3 w-3" /> WebSocket 隧道
                    </Badge>
                    <Badge variant="outline" className="gap-1">
                      <Activity className="h-3 w-3" /> 实时监控
                    </Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t py-4 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-xs text-muted-foreground text-center">
            TunnelNet - 固定域名内网穿透服务 | 基于 WebSocket 隧道技术
          </p>
        </div>
      </footer>
    </div>
  );
}
