import jinja2, base64
from pathlib import Path
from playwright.async_api import async_playwright

async def html2pic(template_path: str, template_name: str, **template_vars) -> bytes:
    """
    渲染函数：将 Jinja2 模板转为图片
    :param template_path: 模板所在的文件夹路径
    :param template_name: 模板文件名
    :param template_vars: 传给模板的变量名和值
    """
    env = jinja2.Environment(loader=jinja2.FileSystemLoader(template_path))
    template = env.get_template(template_name)

    bg_path = Path(template_path) / "img.jpg"
    if bg_path.exists():
        with open(bg_path, "rb") as f:
            bg_base64 = base64.b64encode(f.read()).decode()
            template_vars["bg_data"] = f"data:image/jpeg;base64,{bg_base64}"


    content = template.render(**template_vars)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 850, "height": 10})

        await page.set_content(content)
        img_bytes = await page.screenshot(full_page=True)

        await browser.close()
        return img_bytes