#!/bin/bash

# 核心安全保障：强制将脚本工作目录切换到脚本所在目录
cd "$(dirname "$0")"

# 核心配置：以当前文件夹的名字作为 Docker Compose 的项目名，确保彻底物理隔离
PROJECT_NAME=$(basename "$(pwd)")
COMPOSE_FILE="docker-compose.yml"

# 简易高亮颜色
G='\033[0;32m' # 绿
Y='\033[1;33m' # 黄
R='\033[0;31m' # 红
NC='\033[0m'   # 重置

while true; do
    clear
    echo -e "🐳 ${G}Docker 本地控制台${NC} [当前项目: ${Y}${PROJECT_NAME}${NC}]"
    echo "────────────────────────────────────────"
    echo -e "  ${G}1.${NC} 🚀 启动服务 (后台)"
    echo -e "  ${G}2.${NC} 🛑 停止服务"
    echo -e "  ${G}3.${NC} 🔄 重启服务"
    echo -e "  ${Y}4.${NC} 📝 查看实时日志"
    echo -e "  ${Y}5.${NC} 📊 查看运行状态"
    echo -e "  ${R}6.${NC} 🗑️  清理本项目 (连带数据卷)"
    echo -e "  ${R}0.${NC} 🚪 退出"
    echo "────────────────────────────────────────"
    
    read -p "请输入指令: " opt
    echo -e "\n----------------------------------------"

    # 使用 -p $PROJECT_NAME 强行打上目录标签，防止多项目混淆
    case $opt in
        1) docker compose -f $COMPOSE_FILE -p $PROJECT_NAME up -d ;;
        2) docker compose -f $COMPOSE_FILE -p $PROJECT_NAME stop ;;
        3) docker compose -f $COMPOSE_FILE -p $PROJECT_NAME restart ;;
        4) docker compose -f $COMPOSE_FILE -p $PROJECT_NAME logs -f --tail=50 ;;
        5) docker compose -f $COMPOSE_FILE -p $PROJECT_NAME ps ;;
        6) 
            read -p "👉 确定要完全删除当前目录的容器和数据吗？(y/N): " confirm
            if [[ "$confirm" =~ ^[Yy]$ ]]; then
                docker compose -f $COMPOSE_FILE -p $PROJECT_NAME down -v --remove-orphans
            fi
            ;;
        0) echo "已退出。"; exit 0 ;;
        *) echo -e "${R}无效输入，请重新选择${NC}" ;;
    esac

    echo -e "----------------------------------------"
    read -p "按回车键继续..."
done