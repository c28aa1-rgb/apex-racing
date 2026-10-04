"""Development utility: plot road-material vertices from a supplied GLB."""
import json, re, struct, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

COMPONENTS={5120:np.int8,5121:np.uint8,5122:np.int16,5123:np.uint16,5125:np.uint32,5126:np.float32}
WIDTH={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}

def read_glb(path):
    raw=Path(path).read_bytes();json_length,kind=struct.unpack_from('<II',raw,12)
    assert kind==0x4E4F534A
    data=json.loads(raw[20:20+json_length].decode().rstrip('\0 '))
    offset=20+json_length
    binary_length,binary_kind=struct.unpack_from('<II',raw,offset)
    assert binary_kind==0x004E4942
    return data,memoryview(raw)[offset+8:offset+8+binary_length]

def accessor(data,binary,index):
    item=data['accessors'][index];view=data['bufferViews'][item['bufferView']]
    dtype=np.dtype(COMPONENTS[item['componentType']]).newbyteorder('<');width=WIDTH[item['type']]
    start=view.get('byteOffset',0)+item.get('byteOffset',0);stride=view.get('byteStride',dtype.itemsize*width)
    return np.ndarray((item['count'],width),dtype=dtype,buffer=binary,offset=start,strides=(stride,dtype.itemsize)).copy()

def local_matrix(node):
    if 'matrix' in node:return np.array(node['matrix'],dtype=float).reshape((4,4),order='F')
    translation=np.array(node.get('translation',[0,0,0]),dtype=float);scale=np.array(node.get('scale',[1,1,1]),dtype=float)
    x,y,z,w=node.get('rotation',[0,0,0,1])
    rotation=np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w,0],[2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w,0],[2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y,0],[0,0,0,1]],dtype=float)
    result=rotation@np.diag([scale[0],scale[1],scale[2],1]);result[:3,3]=translation;return result

def main(path,pattern,output):
    data,binary=read_glb(path);matcher=re.compile(pattern,re.I);materials=data.get('materials',[])
    selected={index for index,item in enumerate(materials) if matcher.search(item.get('name',''))}
    vertices=[];triangles=[];world={}
    def visit(index,parent):
        node=data['nodes'][index];matrix=parent@local_matrix(node);world[index]=matrix
        if 'mesh' in node:
            for primitive in data['meshes'][node['mesh']]['primitives']:
                if primitive.get('material') not in selected:continue
                positions=accessor(data,binary,primitive['attributes']['POSITION']);homogeneous=np.c_[positions,np.ones(len(positions))]
                transformed=(matrix@homogeneous.T).T[:,:3];vertices.append(transformed)
                indices=accessor(data,binary,primitive['indices']).reshape(-1).astype(np.int64) if 'indices' in primitive else np.arange(len(transformed))
                faces=transformed[indices[:len(indices)//3*3].reshape(-1,3)]
                normals=np.cross(faces[:,1]-faces[:,0],faces[:,2]-faces[:,0]);flat=np.abs(normals[:,1])>np.linalg.norm(normals,axis=1)*.55
                triangles.extend(faces[flat])
        for child in node.get('children',[]):visit(child,matrix)
    for root in data['scenes'][data.get('scene',0)]['nodes']:visit(root,np.eye(4))
    points=np.concatenate(vertices) if vertices else np.empty((0,3))
    print(json.dumps({'materials':[materials[i].get('name') for i in sorted(selected)],'vertices':len(points),'min':points.min(0).tolist() if len(points) else None,'max':points.max(0).tolist() if len(points) else None},indent=2))
    size=1600;canvas=np.zeros((size,size,3),dtype=np.uint8);canvas[:]=[19,43,59]
    if len(points):
        low=points[:,[0,2]].min(0);high=points[:,[0,2]].max(0);span=max(high-low);margin=50
        pixels=((points[:,[0,2]]-low)/max(span,1)*(size-margin*2)+margin).astype(int)
        pixels[:,1]=size-1-pixels[:,1];pixels=np.clip(pixels,0,size-1)
        for dx in (-1,0,1):
            for dy in (-1,0,1):canvas[np.clip(pixels[:,1]+dy,0,size-1),np.clip(pixels[:,0]+dx,0,size-1)]=[241,250,238]
    Image.fromarray(canvas).save(output)
    if triangles:
        mask=Image.new('L',(size,size),0);draw=ImageDraw.Draw(mask)
        for face in triangles:
            mapped=((face[:,[0,2]]-low)/max(span,1)*(size-margin*2)+margin);mapped[:,1]=size-1-mapped[:,1]
            draw.polygon([tuple(value) for value in mapped],fill=255)
        mask.save(str(Path(output).with_name(Path(output).stem+'-mask.png')))
    routes={
        # Deliberately authored as point-to-point stages along the visible racing
        # surface. Keeping these short avoids ambiguous pit-lane intersections.
        'bugatti-surface':[(90,390),(88,450),(102,600),(132,740),(180,840),(250,915),(320,970),(344,1010)],
        'bug-stripe':[(90,400),(95,550),(105,700),(135,820),(205,900),(335,990),(330,1060),(400,1100),(485,1150),(550,1230),(610,1260),(655,1245),(675,1210),(660,1160),(610,1090),(545,1020),(475,960),(445,930),(475,905),(540,900),(610,925),(690,985),(760,1060),(815,1130),(845,1165),(865,1160),(880,1130),(865,1100),(820,1040),(760,970),(700,900),(625,825),(555,750),(490,680),(445,620),(435,585),(460,550),(455,515),(425,420),(390,330),(360,265),(325,240),(300,245),(265,275),(225,300),(190,300),(160,280),(140,240),(120,180),(105,155),(90,180),(90,300),(90,400),(92,500)],
        'spa-surface':[(220,1510),(245,1450),(270,1400),(300,1350),(332,1300),(365,1250),(390,1200),(390,1150),(375,1100),(385,1050),(395,1000),(410,950),(430,900),(452,850),(475,800),(475,750),(455,700),(435,650),(405,600),(360,550),(250,500),(185,450),(140,400),(100,350),(82,300),(75,250),(95,200),(165,150)],
        'bugatti-full':[(100,400),(105,550),(120,700),(180,850),(260,960),(340,1020),(420,1100),(520,1200),(600,1260),(660,1250),(700,1200),(700,1140),(650,1070),(580,980),(500,900),(450,820),(430,700),(400,580),(370,420),(330,300),(280,250),(220,280),(180,320),(130,300),(100,250),(90,180),(100,130),(130,100),(160,120),(150,180),(130,250),(110,350),(100,400),(105,500)],        'spa-main':[(410,1130),(390,1050),(420,950),(460,850),(470,760),(450,650),(410,520),(370,370),(330,280),(290,250),(250,270),(210,300),(150,300),(95,260),(60,210),(55,150),(85,105),(145,65),(195,55),(225,90),(250,150),(280,205),(320,235),(360,225),(405,195),(455,190),(500,220),(530,280),(555,360),(585,470),(620,540),(680,570),(740,570),(790,540),(825,480),(845,400),(870,310),(890,225),(875,170),(830,125),(780,90),(735,55),(700,60),(690,100),(720,135),(770,175),(805,220),(800,280),(770,360),(730,470),(690,600),(650,730),(610,850),(560,950),(500,1020),(450,1080),(410,1130),(395,1060)],        'hungary-road':[(560,390),(690,285),(820,180),(900,110),(965,80),(1010,100),(1040,155),(1000,220),(960,275),(1040,220),(1140,300),(1240,390),(1340,480),(1390,560),(1380,640),(1330,720),(1300,800),(1305,930),(1330,1010),(1260,1030),(1160,1030),(1135,1110),(1130,1240),(1070,1310),(970,1400),(900,1510),(820,1515),(810,1450),(850,1320),(850,1220),(780,1140),(700,1040),(630,930),(560,800),(590,700),(660,620),(650,550),(610,510),(560,520),(500,570),(430,640),(350,700),(250,740),(150,760),(90,750),(75,720),(90,690),(160,630),(260,550),(380,470),(500,380),(560,330),(620,280)],        'barcelona-road':[(850,600),(930,720),(1020,850),(1110,990),(1200,1130),(1260,1230),(1300,1300),(1280,1360),(1210,1410),(1100,1420),(1020,1380),(980,1320),(900,1340),(820,1400),(760,1460),(700,1500),(650,1490),(600,1440),(520,1370),(450,1320),(430,1260),(480,1210),(540,1180),(590,1120),(610,1040),(630,950),(610,880),(560,820),(500,760),(430,700),(360,650),(300,590),(260,520),(250,420),(220,330),(160,240),(100,180),(80,110),(100,70),(160,50),(220,60),(300,100),(360,140),(410,150),(460,130),(500,100),(530,100),(550,130),(570,170),(590,220),(610,260),(640,280),(680,260),(720,230),(760,210),(800,220),(830,260),(820,300),(790,320),(760,330),(770,360),(810,380),(850,390),(870,470),(850,600),(900,675)],        'indy-road':[(1000,1505),(800,1505),(600,1505),(400,1505),(250,1485),(150,1430),(90,1340),(70,1220),(70,1050),(90,960),(150,900),(240,860),(350,850),(600,850),(900,850),(1200,850),(1350,870),(1450,930),(1510,1020),(1530,1140),(1530,1300),(1500,1420),(1440,1480),(1350,1505),(1200,1505),(1000,1505),(900,1505)],        'marina-road2':[(120,850),(110,1000),(100,1130),(120,1230),(190,1280),(300,1280),(430,1270),(550,1260),(700,1260),(830,1250),(900,1210),(960,1130),(1030,1040),(1110,980),(1170,1000),(1210,1080),(1230,1200),(1250,1350),(1290,1500),(1360,1510),(1430,1450),(1490,1380),(1510,1280),(1480,1180),(1430,1090),(1380,1000),(1330,900),(1290,820),(1240,800),(1190,850),(1130,920),(1080,980),(1030,980),(990,920),(960,850),(930,780),(900,730),(850,700),(800,710),(750,740),(700,770),(620,830),(540,900),(470,970),(400,990),(330,990),(290,960),(280,900),(300,820),(320,720),(330,620),(330,520),(310,450),(270,430),(220,450),(190,500),(175,600),(160,720),(140,800),(120,850),(115,950)],    }
    route=routes.get(Path(output).stem)
    if route and len(points):
        overlay=Image.open(output).convert('RGB');overlay_draw=ImageDraw.Draw(overlay)
        overlay_draw.line(route,fill=(255,120,76),width=4)
        for px,py in route:overlay_draw.ellipse((px-6,py-6,px+6,py+6),fill=(89,216,208),outline=(255,255,255),width=2)
        overlay.save(str(Path(output).with_name(Path(output).stem+'-route.png')))
        result=[]
        for px,py in route:
            x=low[0]+(px-margin)/(size-margin*2)*span;z=low[1]+((size-1-py)-margin)/(size-margin*2)*span
            nearest=points[np.argmin((points[:,0]-x)**2+(points[:,2]-z)**2)]
            # Keep the authored X/Z centerline. Mesh vertices often sit on the road
            # edges, so snapping all three axes can put the car on a kerb or verge.
            result.append([round(float(x),2),round(float(nearest[1]+.08),2),round(float(z),2)])
        print('ROUTE='+json.dumps(result,separators=(',',':')))

if __name__=='__main__':main(*sys.argv[1:4])
