# Quick self-test: starts a throw-away server on port 8181 and exercises accounts, permissions, queries, live events and the lite API. Run: python3 server/selftest.py
import json,subprocess,time,urllib.request,threading,os,sys,tempfile
d=tempfile.mkdtemp()
p=subprocess.Popen([sys.executable,os.path.join(os.path.dirname(os.path.abspath(__file__)),"qm_server.py"),"--port","8181","--data",d],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
time.sleep(1)
def call(path,body=None,tok=None):
    r=urllib.request.Request("http://localhost:8181/api/"+path,data=json.dumps(body).encode() if body is not None else None,headers={"Authorization":"Bearer "+tok} if tok else {})
    try: return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e: return {"HTTP":e.code,**json.loads(e.read())}
a=call("auth/signup",{"email":"a@x.com","password":"secret1"}); b=call("auth/signup",{"email":"b@x.com","password":"secret2"}); c=call("auth/signup",{"email":"c@x.com","password":"secret3"})
print("signup",bool(a.get("token")),call("auth/signup",{"email":"a@x.com","password":"secret1"}).get("error"))
ua,ub,uc=a["user"]["uid"],b["user"]["uid"],c["user"]["uid"]; ta,tb,tc=a["token"],b["token"],c["token"]
print("badlogin",call("auth/login",{"email":"a@x.com","password":"no"}).get("HTTP"))
# create chat
print("create",call("db/update",{"updates":{"privateChats/c1":{"participants":{ua:True,ub:True},"lastMessage":{"fromUid":"","text":"x","timestamp":1}},"chatList/%s/c1"%ua:True,"chatList/%s/c1"%ub:True}},ta))
print("outsider read denied",call("db/get",{"path":"privateChats/c1"},tc).get("HTTP"))
print("outsider write denied",call("db/update",{"updates":{"privateChats/c1/messages/m1":{"fromUid":uc,"text":"hi","timestamp":1}}},tc).get("HTTP"))
print("spoof denied",call("db/update",{"updates":{"privateChats/c1/messages/m1":{"fromUid":ua,"text":"hi","timestamp":1}}},tb).get("HTTP"))
print("send",call("db/update",{"updates":{"privateChats/c1/messages/m1":{"fromUid":ub,"text":"hi","timestamp":{".sv":"timestamp"}}}},tb))
print("get",call("db/get",{"path":"privateChats/c1/messages","query":{"orderBy":"key","limitLast":5}},ta))
print("own-only settings",call("db/update",{"updates":{"accsettings/%s/settings"%ub:{"displayName":"x"}}},ta).get("HTTP"))
print("lite",call("lite/chats",None,ta)["chats"][0]["id"], call("lite/send",{"chat":"c1","text":"from lite"},ta), len(call("lite/messages?chat=c1",None,ta)["messages"]))
# SSE
import http.client
conn=http.client.HTTPConnection("localhost",8181); conn.request("GET","/api/stream?cid=client-0001&token="+ta); r=conn.getresponse()
ev=[]
def rd():
    buf=b""
    while True:
        l=r.fp.readline()
        if not l: break
        if l.startswith(b"data: "): ev.append(json.loads(l[6:]))
threading.Thread(target=rd,daemon=True).start()
time.sleep(.3)
print("listen",call("listen",{"cid":"client-0001","lid":"l1","path":"privateChats/c1/messages","query":{"orderBy":"key"},"mode":"child"},ta))
print("listen-denied",call("listen",{"cid":"client-0001","lid":"l2","path":"privateChats/zzz","mode":"value"},ta).get("HTTP"))
time.sleep(.3); call("db/update",{"updates":{"privateChats/c1/messages/m2":{"fromUid":ub,"text":"live","timestamp":2}}},tb); time.sleep(.5)
print("events",[ (e["type"], len(e.get("items",e.get("ups",[])))) for e in ev if "type" in e])
p.terminate()
print('selftest done')
