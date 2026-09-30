import argparse,base64,hashlib,json,re,urllib.parse,urllib.request,urllib.error
parser=argparse.ArgumentParser(description='Verify Harbor authentication, private OCI push/pull, and component health.')
parser.add_argument('--url', default='https://harbor.laptop')
parser.add_argument('--secrets', required=True, help='The exact rendered Secret JSON; values are never logged')
args=parser.parse_args()
url=args.url.rstrip('/')
source=json.load(open(args.secrets))
core=next(r for r in source['items'] if r['metadata']['name']=='harbor-core')
password=base64.b64decode(core['data']['HARBOR_ADMIN_PASSWORD']).decode()
basic='Basic '+base64.b64encode(('admin:'+password).encode()).decode()
def request(path,method='GET',body=None,auth=basic,content_type='application/json'):
    data=json.dumps(body).encode() if isinstance(body,dict) else body
    req=urllib.request.Request(path if path.startswith('http') else url+path,method=method,data=data,headers={'Authorization':auth,'Content-Type':content_type,'Accept':'application/vnd.oci.image.manifest.v1+json, application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.status,response.headers,response.read()
status,_,body=request('/api/v2.0/users/current')
assert status==200 and json.loads(body)['username']=='admin'
print('Admin authentication: passed')
try:
 request('/api/v2.0/projects','POST',{'project_name':'quadlet-smoke','metadata':{'public':'false'}})
except urllib.error.HTTPError as e:
 if e.code!=409: raise
try:
 request('/v2/',auth='')
except urllib.error.HTTPError as e:
 assert e.code==401
 challenge=e.headers['WWW-Authenticate']
realm=re.search(r'realm="([^"]+)"',challenge)[1]
service=re.search(r'service="([^"]+)"',challenge)[1]
_,_,body=request(realm+'?'+urllib.parse.urlencode({'service':service,'scope':'repository:quadlet-smoke/probe:pull,push'}))
bearer='Bearer '+json.loads(body)['token']
config=json.dumps({'architecture':'amd64','os':'linux','rootfs':{'type':'layers','diff_ids':[]}},separators=(',',':')).encode()
digest='sha256:'+hashlib.sha256(config).hexdigest()
_,headers,_=request('/v2/quadlet-smoke/probe/blobs/uploads/','POST',b'',bearer)
location=headers['Location']
location+=('&' if '?' in location else '?')+'digest='+digest
status,_,_=request(location,'PUT',config,bearer,'application/octet-stream')
assert status==201
manifest={'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':digest,'size':len(config)},'layers':[]}
status,_,_=request('/v2/quadlet-smoke/probe/manifests/latest','PUT',manifest,bearer,'application/vnd.oci.image.manifest.v1+json')
assert status==201
_,_,body=request('/v2/quadlet-smoke/probe/manifests/latest',auth=bearer)
assert json.loads(body)['config']['digest']==digest
_,_,body=request('/v2/quadlet-smoke/probe/blobs/'+digest,auth=bearer)
assert body==config
print('Private registry token, OCI image push and pull: passed')
_,_,body=request('/api/v2.0/health')
health=json.loads(body)
assert health['status']=='healthy',health
print('All eight Harbor components: healthy')
