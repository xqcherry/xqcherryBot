#!/bin/bash

# 核心配置
COMPOSE_FILE="docker-compose.yml"
# 🌟 这里定义你的 NoneBot 在 docker-compose.yml 中的服务名
NONEBOT_SERVICE_NAME="nonebot"

# 颜色定义
G='\033[0;32m' # 绿
Y='\033[1;33m' # 黄
R='\033[0;31m' # 红
C='\033[0;36m' # 青
NC='\033[0m'    # 重置

while true; do
    clear
    echo -e "${C}┌────────────────────────────────────────┐${NC}"
    echo -e "${C}│${NC}      🐳 ${G}DOCKER${NC} 控制台  -  ${Y}核心版${NC}       ${C}│${NC}"
    echo -e "${C}├────────────────────────────────────────┤${NC}"
    echo -e "${C}│${NC}  ${G}1.${NC} 🚀 启动全部服务   ${G}2.${NC} 🛑 停止全部服务 ${C}│${NC}"
    echo -e "${C}│${NC}  ${G}3.${NC} 🔄 重启全部服务   ${G}31.${NC}⚡ ${G}仅重启 NoneBot${C} │${NC}"
    echo -e "${C}│${NC}  ${G}4.${NC} 🏗️  重新构建全部   ${G}41.${NC}🛠️  ${G}构建+重载NB  ${C}│${NC}"
    echo -e "${C}│${NC}  ${Y}5.${NC} 📝 实时全部日志   ${Y}51.${NC}⚡ ${Y}选择服务日志  ${C}│${NC}"
    echo -e "${C}│${NC}  ${Y}6.${NC} 📊 运行状态       ${Y}7.${NC} 💻 进入容器     ${C}│${NC}"
    echo -e "${C}│${NC}  ${R}8.${NC} 🧹 清理本项目     ${R}0.${NC} 🚪 退出脚本     ${C}│${NC}"
    echo -e "${C}└────────────────────────────────────────┘${NC}"
    
    read -p "请输入指令: " opt
    echo -e "\n------------------------------------------"

    case $opt in
        1) docker compose -f $COMPOSE_FILE up -d ;;
        2) docker compose -f $COMPOSE_FILE stop ;;
        3) docker compose -f $COMPOSE_FILE restart ;;
        31) 
            echo -e "${Y}正在单独重启 NoneBot 服务...${NC}"
            docker compose -f $COMPOSE_FILE restart $NONEBOT_SERVICE_NAME 
            ;;
        4) docker compose -f $COMPOSE_FILE build ;;
        41)
            echo -e "${Y}正在重新构建并启动 NoneBot 服务...${NC}"
            docker compose -f $COMPOSE_FILE build $NONEBOT_SERVICE_NAME
            docker compose -f $COMPOSE_FILE up -d --no-deps $NONEBOT_SERVICE_NAME
            ;;
        5) docker compose -f $COMPOSE_FILE logs -f --tail=50 ;;
        51)
            # 动态获取 docker-compose 里的所有服务（包括没运行的也能选）
            services=($(docker compose -f $COMPOSE_FILE ps --services))
            if [ ${#services[@]} -eq 0 ]; then
                echo -e "${R}未找到任何配置的服务！${NC}"
            else
                echo -e "${Y}请选择要查看日志的服务:${NC}"
                for i in "${!services[@]}"; do
                    # 顺便检测服务是否在线，打个绿色/灰色的标签
                    status=$(docker compose -f $COMPOSE_FILE ps --filter "status=running" --services | grep -w "${services[$i]}")
                    if [ -n "$status" ]; then
                        echo -e "  ${G}$i)${NC} ${services[$i]} ${G}(运行中)${NC}"
                    else
                        echo -e "  ${G}$i)${NC} ${services[$i]} (已停止)"
                    fi
                done
                read -p "输入编号 (默认为 0): " service_idx
                service_idx=${service_idx:-0}
                target_service=${services[$service_idx]}
                
                if [ -n "$target_service" ]; then
                    echo -e "${G}正在追踪 $target_service 的实时日志 (Ctrl+C 退出)...${NC}"
                    echo -e "------------------------------------------"
                    docker compose -f $COMPOSE_FILE logs -f --tail=50 $target_service
                else
                    echo -e "${R}无效编号${NC}"
                fi
            fi
            ;;
        6) docker compose -f $COMPOSE_FILE ps ;;
        7) 
            services=($(docker compose -f $COMPOSE_FILE ps --services --filter "status=running"))
            if [ ${#services[@]} -eq 0 ]; then
                echo -e "${R}没有正在运行的容器！${NC}"
            else
                echo -e "${Y}请选择要进入的容器:${NC}"
                for i in "${!services[@]}"; do
                    echo -e "  ${G}$i)${NC} ${services[$i]}"
                done
                read -p "输入编号 (默认为 0): " service_idx
                service_idx=${service_idx:-0}
                target_service=${services[$service_idx]}
                
                if [ -n "$target_service" ]; then
                    echo -e "${G}正在进入 $target_service ...${NC}"
                    MSYS_NO_PATHCONV=1 docker compose -f $COMPOSE_FILE exec $target_service /bin/sh -c "[ -e /bin/bash ] && /bin/bash || /bin/sh"
                else
                    echo -e "${R}无效编号${NC}"
                fi
            fi
            ;;
        8) 
            echo -e "${R}警告：将删除本项目所有容器、网络及未使用的卷${NC}"
            read -p "确定清理本项目? (y/n): " confirm
            if [[ "$confirm" == "y" ]]; then
                docker compose -f $COMPOSE_FILE down -v --remove-orphans
                echo -e "${G}本项目已清理干净。${NC}"
            fi
            ;;
        0) echo "已退出。"; exit 0 ;;
        *) echo -e "${R}无效输入${NC}" ;;
    esac

    echo -e "------------------------------------------"
    read -p "按回车键继续..."
done