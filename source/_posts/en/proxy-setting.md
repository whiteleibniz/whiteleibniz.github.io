---
title: Building a Proxy Server Using a Virtual Host
search: true
categories:
- 系统配置
tag:
- 代理
- Webstorm
typora-root-url: proxy-setting
lang: en
permalink: en/2026/10/12/proxy-setting/
---
For those who often need to access foreign websites: due to the restrictions of the *GFW*, many websites are inaccessible. This article uses an overseas virtual host and SOCKS5 forwarding technology to set up a proxy server, thereby achieving free access to various websites.
## Preparation

- Overseas virtual host: I use [Laoxue Host](https://my.laoxuehost.net/aff.php?aff=5278); the coupon code (laoxue25la) is 40 RMB per year, and SSH access must be enabled.
- putty: this article uses SSH port forwarding to implement a SOCKS5 proxy.
-  plink: a tool included in the putty package.
- Firefox browser: configure the browser's proxy server for browsing blocked websites.
- webstorm: configure webstorm to download plugins.

## Configuration

##### Create a shortcut for plink.exe and then add the following parameters:
![plink](plink.png)

~~~bash
plink.exe -v -C -N -D 127.0.0.1:7000 -l root -pw password -P 22 xxx.xxx.xxx.xxx
~~~

plink.exe - display detailed information  
- enable data compression  
- do not display the shell  
- dynamic port forwarding, proxy IP:port  
-l remote host username  
-pw automatically enter the user password  
-P remote host port, remote host IP

###### On successful startup, the following is displayed:
![proxy](proxy.png)

###### 1. Browser configuration:
![browse](browser.png)

###### 2. webstorm configuration:
![webstorm](webstorm.png)
